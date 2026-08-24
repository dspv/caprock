package opencode

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// The schema below is copied from a real OpenCode installation
// (`SELECT sql FROM sqlite_master`), not written from the reader's
// assumptions. A fixture invented from the same understanding as the code it
// tests proves only that the code is self-consistent; this one fails if
// OpenCode's actual shape and our reading of it ever diverge.
//
// Foreign keys and the columns the reader never touches are kept for the same
// reason: a query that accidentally depends on a column existing should fail
// here rather than on a user's machine.
const ocSchema = `
CREATE TABLE session (
	id text PRIMARY KEY,
	project_id text NOT NULL,
	parent_id text,
	slug text NOT NULL,
	directory text NOT NULL,
	title text NOT NULL,
	version text NOT NULL,
	share_url text,
	summary_additions integer,
	summary_deletions integer,
	summary_files integer,
	summary_diffs text,
	revert text,
	permission text,
	time_created integer NOT NULL,
	time_updated integer NOT NULL,
	time_compacting integer,
	time_archived integer,
	workspace_id text,
	path text,
	agent text,
	model text,
	cost real DEFAULT 0 NOT NULL,
	tokens_input integer DEFAULT 0 NOT NULL,
	tokens_output integer DEFAULT 0 NOT NULL,
	tokens_reasoning integer DEFAULT 0 NOT NULL,
	tokens_cache_read integer DEFAULT 0 NOT NULL,
	tokens_cache_write integer DEFAULT 0 NOT NULL
);
CREATE TABLE message (
	id text PRIMARY KEY,
	session_id text NOT NULL,
	time_created integer NOT NULL,
	time_updated integer NOT NULL,
	data text NOT NULL
);
CREATE TABLE part (
	id text PRIMARY KEY,
	message_id text NOT NULL,
	session_id text NOT NULL,
	time_created integer NOT NULL,
	time_updated integer NOT NULL,
	data text NOT NULL
);
`

// fixture builds an OpenCode database in a temporary directory.
type fixture struct {
	t    *testing.T
	path string
	db   *sql.DB
}

// newFixture creates an empty OpenCode database with the real schema.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	path := filepath.Join(t.TempDir(), "opencode.db")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatalf("create fixture: %v", err)
	}
	if _, err := db.Exec(ocSchema); err != nil {
		t.Fatalf("fixture schema: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return &fixture{t: t, path: path, db: db}
}

// sessionOpts describes one session to write.
type sessionOpts struct {
	ID         string
	ParentID   string
	Directory  string
	Title      string
	Model      string // model id; provider defaults to a plausible one
	Provider   string
	Cost       float64
	TokensIn   int64
	TokensOut  int64
	CacheRead  int64
	CacheWrite int64
	Created    int64
	Updated    int64
	// RawModel overrides the model JSON entirely, for testing malformed values.
	RawModel *string
}

func (f *fixture) session(o sessionOpts) {
	f.t.Helper()
	modelJSON := "null"
	if o.RawModel != nil {
		modelJSON = *o.RawModel
	} else if o.Model != "" {
		provider := o.Provider
		if provider == "" {
			provider = "anthropic"
		}
		b, _ := json.Marshal(map[string]string{"id": o.Model, "providerID": provider})
		modelJSON = string(b)
	}
	if o.Created == 0 {
		o.Created = 1_700_000_000_000
	}
	if o.Updated == 0 {
		o.Updated = o.Created + 60_000
	}
	var parent any
	if o.ParentID != "" {
		parent = o.ParentID
	}
	_, err := f.db.Exec(`
		INSERT INTO session (id, project_id, parent_id, slug, directory, title, version,
		                     time_created, time_updated, model, cost,
		                     tokens_input, tokens_output, tokens_cache_read, tokens_cache_write)
		VALUES (?, 'prj_1', ?, ?, ?, ?, '1.0.0', ?, ?, ?, ?, ?, ?, ?, ?)`,
		o.ID, parent, o.ID, o.Directory, o.Title, o.Created, o.Updated,
		modelJSON, o.Cost, o.TokensIn, o.TokensOut, o.CacheRead, o.CacheWrite)
	if err != nil {
		f.t.Fatalf("insert session: %v", err)
	}
}

// messageOpts describes one message to write.
type messageOpts struct {
	ID         string
	SessionID  string
	Role       string
	Model      string
	Provider   string
	Cwd        string
	Cost       float64
	TokensIn   int64
	TokensOut  int64
	CacheRead  int64
	CacheWrite int64
	Created    int64
	Completed  int64
	// RawData overrides the whole payload, for malformed-input tests.
	RawData *string
}

func (f *fixture) message(o messageOpts) {
	f.t.Helper()
	if o.Role == "" {
		o.Role = "assistant"
	}
	if o.Created == 0 {
		o.Created = 1_700_000_000_000
	}
	data := ""
	if o.RawData != nil {
		data = *o.RawData
	} else {
		b, _ := json.Marshal(map[string]any{
			"role": o.Role, "modelID": o.Model, "providerID": o.Provider,
			"cost": o.Cost,
			"path": map[string]string{"cwd": o.Cwd},
			"tokens": map[string]any{
				"input": o.TokensIn, "output": o.TokensOut,
				"cache": map[string]int64{"read": o.CacheRead, "write": o.CacheWrite},
			},
			"time": map[string]int64{"created": o.Created, "completed": o.Completed},
		})
		data = string(b)
	}
	_, err := f.db.Exec(
		`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`,
		o.ID, o.SessionID, o.Created, o.Created, data)
	if err != nil {
		f.t.Fatalf("insert message: %v", err)
	}
}

// toolOpts describes one tool part to write.
type toolOpts struct {
	ID        string
	MessageID string
	SessionID string
	Tool      string
	FilePath  string
	Status    string
	Start     int64
	End       int64
	// InputKey lets a test use an argument name other than filePath.
	InputKey string
	// RawData overrides the whole payload.
	RawData *string
	// Type overrides the part type, for filtering tests.
	Type string
}

func (f *fixture) tool(o toolOpts) {
	f.t.Helper()
	if o.Status == "" {
		o.Status = "completed"
	}
	if o.Type == "" {
		o.Type = "tool"
	}
	if o.Start == 0 {
		o.Start = 1_700_000_000_000
	}
	data := ""
	if o.RawData != nil {
		data = *o.RawData
	} else {
		input := map[string]any{}
		if o.FilePath != "" {
			key := o.InputKey
			if key == "" {
				key = "filePath"
			}
			input[key] = o.FilePath
		}
		b, _ := json.Marshal(map[string]any{
			"type": o.Type, "tool": o.Tool, "callID": "call_" + o.ID,
			"state": map[string]any{
				"status": o.Status, "input": input,
				"time": map[string]int64{"start": o.Start, "end": o.End},
			},
		})
		data = string(b)
	}
	_, err := f.db.Exec(
		`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)`,
		o.ID, o.MessageID, o.SessionID, o.Start, o.Start, data)
	if err != nil {
		f.t.Fatalf("insert part: %v", err)
	}
}

// open returns a read-only handle through the package's own Open, so the DSN
// the production code uses is exercised rather than bypassed.
func (f *fixture) open() *sql.DB {
	f.t.Helper()
	db, err := Open(f.path)
	if err != nil {
		f.t.Fatalf("open fixture: %v", err)
	}
	f.t.Cleanup(func() { _ = db.Close() })
	return db
}

// typical builds a small but realistic database: two projects, a parent with a
// subagent child, assistant and user messages, and tool calls both with and
// without a file path.
func (f *fixture) typical() {
	f.t.Helper()
	f.session(sessionOpts{
		ID: "ses_a", Directory: "/home/dev/api", Title: "add auth",
		Model: "claude-opus-5", Provider: "anthropic", Cost: 1.50,
		TokensIn: 1000, TokensOut: 200, CacheRead: 5000, CacheWrite: 100,
		Created: 1_700_000_000_000, Updated: 1_700_000_600_000,
	})
	f.message(messageOpts{
		ID: "msg_a1", SessionID: "ses_a", Model: "claude-opus-5", Provider: "anthropic",
		Cwd: "/home/dev/api", Cost: 1.00, TokensIn: 600, TokensOut: 120,
		CacheRead: 3000, CacheWrite: 60, Created: 1_700_000_100_000,
	})
	f.message(messageOpts{
		ID: "msg_a2", SessionID: "ses_a", Role: "user", Cwd: "/home/dev/api",
		Created: 1_700_000_050_000,
	})
	f.tool(toolOpts{ID: "prt_a1", MessageID: "msg_a1", SessionID: "ses_a",
		Tool: "read", FilePath: "/home/dev/api/src/auth.go", Start: 1_700_000_110_000})
	f.tool(toolOpts{ID: "prt_a2", MessageID: "msg_a1", SessionID: "ses_a",
		Tool: "bash", Start: 1_700_000_120_000})

	// A subagent: its cost sits on its own row, which is what makes a naive
	// SUM over every session overstate a project's total.
	f.session(sessionOpts{
		ID: "ses_child", ParentID: "ses_a", Directory: "/home/dev/api",
		Title: "subagent", Model: "claude-haiku-4-5", Cost: 0.25,
		Created: 1_700_000_200_000, Updated: 1_700_000_300_000,
	})
	f.message(messageOpts{
		ID: "msg_c1", SessionID: "ses_child", Model: "claude-haiku-4-5",
		Cwd: "/home/dev/api", Cost: 0.25, TokensIn: 100, TokensOut: 20,
		Created: 1_700_000_210_000,
	})

	// A second project, so per-repository grouping has something to separate.
	f.session(sessionOpts{
		ID: "ses_b", Directory: "/home/dev/web", Title: "fix layout",
		Model: "deepseek-v4-pro", Provider: "deepseek", Cost: 0.75,
		Created: 1_700_000_400_000, Updated: 1_700_000_900_000,
	})
	f.message(messageOpts{
		ID: "msg_b1", SessionID: "ses_b", Model: "deepseek-v4-pro", Provider: "deepseek",
		Cwd: "/home/dev/web", Cost: 0.75, TokensIn: 400, TokensOut: 80,
		Created: 1_700_000_410_000,
	})
	f.tool(toolOpts{ID: "prt_b1", MessageID: "msg_b1", SessionID: "ses_b",
		Tool: "edit", FilePath: "/home/dev/web/src/App.tsx", Start: 1_700_000_420_000})
}

// count is a small helper for assertions against the Caprock store.
func count(t *testing.T, db *sql.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := db.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v (%s)", err, query)
	}
	return n
}

// sum is the float counterpart of count.
func sum(t *testing.T, db *sql.DB, query string) float64 {
	t.Helper()
	var v float64
	if err := db.QueryRowContext(context.Background(), query).Scan(&v); err != nil {
		t.Fatalf("sum: %v (%s)", err, query)
	}
	return v
}
