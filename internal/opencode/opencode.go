// Package opencode reads sessions from OpenCode's SQLite database.
//
// OpenCode (github.com/sst/opencode) is a second coding agent people run
// alongside Claude Code, and often instead of it. Where Claude Code leaves a
// trail of JSONL transcripts that Caprock has to parse, join and price itself,
// OpenCode keeps one SQLite database in which cost and token counts are already
// computed per session and per message. Reading it is therefore a translation
// job, not an ingestion pipeline: the numbers arrive finished and only have to
// be mapped onto Caprock's event model.
//
// The database is opened read-only. It belongs to another program that may be
// writing to it at the same time, and a monitoring tool that corrupts the thing
// it monitors is worse than no monitoring at all. WAL mode makes concurrent
// readers safe, but the immutable=0 read-only URI is what guarantees we never
// take a write lock and never block a running session.
package opencode

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	_ "modernc.org/sqlite"
)

// Agent is the value written to sessions.agent for everything this package
// produces. It is the string the UI filters on, so it is defined once here.
const Agent = "opencode"

// DBPath returns the path to OpenCode's database, or "" if it is not present.
//
// OpenCode follows the XDG data convention on Unix and uses the same layout
// under LOCALAPPDATA on Windows. Non-stable install channels write to
// opencode-{channel}.db beside the stable one; OPENCODE_DB overrides both.
func DBPath() string {
	if p := os.Getenv("OPENCODE_DB"); p != "" {
		// ":memory:" is legal for OpenCode but meaningless to read from
		// another process, so it counts as "no database".
		if p == ":memory:" {
			return ""
		}
		// A relative value is resolved inside OpenCode's data directory, not
		// against the working directory — that is what OpenCode itself does,
		// and resolving it our way would look for the file beside whichever
		// directory the daemon happened to start in.
		if !filepath.IsAbs(p) {
			for _, dir := range dataDirs() {
				cand := filepath.Join(dir, p)
				if _, err := os.Stat(cand); err == nil {
					return cand
				}
			}
			return ""
		}
		if _, err := os.Stat(p); err == nil {
			return p
		}
		return ""
	}
	for _, dir := range dataDirs() {
		if p := dbInDir(dir); p != "" {
			return p
		}
	}
	return ""
}

// dbInDir finds OpenCode's database inside one data directory.
//
// The filename is not always `opencode.db`. Released builds — the `latest`,
// `beta` and `prod` channels — use that name, but any other build appends its
// channel: a locally-built binary writes `opencode-local.db`, and a preview
// build writes the git branch it came from, sanitised. The set is open-ended
// rather than enumerable, so this looks for the plain name first and falls
// back to whichever suffixed file exists.
func dbInDir(dir string) string {
	plain := filepath.Join(dir, "opencode.db")
	if _, err := os.Stat(plain); err == nil {
		return plain
	}
	matches, err := filepath.Glob(filepath.Join(dir, "opencode-*.db"))
	if err != nil || len(matches) == 0 {
		return ""
	}
	// A machine with several channels installed has several files. Newest
	// wins: it is the one being written to, and picking arbitrarily would
	// show a stale history with no way to tell.
	best, bestMod := "", int64(0)
	for _, m := range matches {
		// The WAL and SHM files sit beside the database and match nothing
		// here, but a future suffix could; skip anything that is not a plain
		// file.
		fi, err := os.Stat(m)
		if err != nil || fi.IsDir() {
			continue
		}
		if mod := fi.ModTime().UnixNano(); mod > bestMod {
			best, bestMod = m, mod
		}
	}
	return best
}

// dataDirs lists the places OpenCode may keep its data directory, most likely
// first.
func dataDirs() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return dataDirsFor(runtime.GOOS, os.Getenv, home)
}

// dataDirsFor is dataDirs with the platform and environment passed in, so the
// search order can be tested for an operating system other than the one the
// test happens to run on. Every path in here is a claim about another
// program's layout, and a claim that only one of three platforms ever
// exercises is a claim nobody checks.
//
// OpenCode uses the `xdg-basedir` package with **no platform branching at
// all** — verified in their source and confirmed by `opencode db path`, which
// prints `~/.local/share/opencode/opencode.db` on macOS. So the Linux
// convention applies everywhere, including Windows, where neither
// LOCALAPPDATA nor APPDATA is consulted. Searching those would have been a
// reasonable guess and a wrong one.
func dataDirsFor(goos string, getenv func(string) string, home string) []string {
	var out []string

	// XDG_DATA_HOME is honoured on every platform, Windows included, because
	// that is simply what the library reads first.
	if xdg := getenv("XDG_DATA_HOME"); xdg != "" {
		out = append(out, filepath.Join(xdg, "opencode"))
	}
	if home != "" {
		out = append(out, filepath.Join(home, ".local", "share", "opencode"))
		// Not where OpenCode writes today, but the platform-native location a
		// future version would most plausibly move to. Checking it costs one
		// stat and would turn a silent "no sessions" into working support.
		if goos == "darwin" {
			out = append(out, filepath.Join(home, "Library", "Application Support", "opencode"))
		}
	}
	_ = goos
	return out
}

// Available reports whether an OpenCode database exists on this machine.
func Available() bool { return DBPath() != "" }

// Open opens OpenCode's database read-only.
func Open(path string) (*sql.DB, error) {
	if path == "" {
		return nil, errors.New("opencode: no database found")
	}
	// mode=ro is the guarantee that matters: this process must never take a
	// write lock on another program's live database.
	dsn := "file:" + filepath.ToSlash(path) + "?mode=ro&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opencode: open: %w", err)
	}
	// One connection is enough for a reader and keeps the footprint on the
	// other program's WAL minimal.
	db.SetMaxOpenConns(1)
	return db, nil
}

// Session is one OpenCode session, with the totals it already carries.
//
// Cost is OpenCode's own figure, computed from models.dev pricing at the time
// the turn ran. It is a modelled number rather than a billed one — the same
// caveat Caprock states for its own pricing — but it is the agent's own
// arithmetic, not ours, so it is used as given rather than recomputed.
type Session struct {
	ID         string
	ParentID   string // non-empty for subagent sessions
	Directory  string
	Title      string
	Model      string
	Provider   string
	Cost       float64
	TokensIn   int64
	TokensOut  int64
	CacheRead  int64
	CacheWrite int64
	Created    int64 // unix ms
	Updated    int64 // unix ms
}

// IsChild reports whether this session is a subagent of another.
//
// This matters for totals: OpenCode stores a subagent's cost on its own row,
// so summing every row double-counts against a parent-inclusive view. On the
// owner's machine that is 47 of 70 sessions and a 1.4% overstatement.
func (s Session) IsChild() bool { return s.ParentID != "" }

// SessionByID returns one session, or false when it is not there.
//
// The live path reads one row rather than the whole table: an event names a
// session, and listing every session to find it turned a per-event read into a
// full scan — enough, on a busy stream, to hold the store's write lock long
// enough for the daemon's own sweeps to fail with SQLITE_BUSY.
func SessionByID(ctx context.Context, db *sql.DB, id string) (Session, bool, error) {
	const q = `
		SELECT id, COALESCE(parent_id,''), COALESCE(directory,''), COALESCE(title,''),
		       COALESCE(model,''), COALESCE(cost,0),
		       COALESCE(tokens_input,0), COALESCE(tokens_output,0),
		       COALESCE(tokens_cache_read,0), COALESCE(tokens_cache_write,0),
		       COALESCE(time_created,0), COALESCE(time_updated,0)
		FROM session WHERE id = ?`
	var s Session
	var modelJSON string
	err := db.QueryRowContext(ctx, q, id).Scan(&s.ID, &s.ParentID, &s.Directory,
		&s.Title, &modelJSON, &s.Cost, &s.TokensIn, &s.TokensOut,
		&s.CacheRead, &s.CacheWrite, &s.Created, &s.Updated)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, false, nil
	}
	if err != nil {
		return Session{}, false, fmt.Errorf("opencode: session %s: %w", id, err)
	}
	s.Model, s.Provider = parseModel(modelJSON)
	return s, true, nil
}

// Sessions returns every session, newest activity first.
func Sessions(ctx context.Context, db *sql.DB) ([]Session, error) {
	const q = `
		SELECT id, COALESCE(parent_id,''), COALESCE(directory,''), COALESCE(title,''),
		       COALESCE(model,''), COALESCE(cost,0),
		       COALESCE(tokens_input,0), COALESCE(tokens_output,0),
		       COALESCE(tokens_cache_read,0), COALESCE(tokens_cache_write,0),
		       COALESCE(time_created,0), COALESCE(time_updated,0)
		FROM session
		ORDER BY time_updated DESC`
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("opencode: sessions: %w", err)
	}
	defer rows.Close()

	var out []Session
	for rows.Next() {
		var s Session
		var modelJSON string
		if err := rows.Scan(&s.ID, &s.ParentID, &s.Directory, &s.Title, &modelJSON,
			&s.Cost, &s.TokensIn, &s.TokensOut, &s.CacheRead, &s.CacheWrite,
			&s.Created, &s.Updated); err != nil {
			return nil, fmt.Errorf("opencode: scan session: %w", err)
		}
		s.Model, s.Provider = parseModel(modelJSON)
		out = append(out, s)
	}
	return out, rows.Err()
}

// parseModel unpacks session.model, which holds {"id":…,"providerID":…}.
//
// A session that has not yet run a turn has no model, and a future OpenCode
// release may change the shape; neither is worth failing an import over, so an
// unreadable value yields empty strings rather than an error.
func parseModel(s string) (model, provider string) {
	if s == "" || s == "null" {
		return "", ""
	}
	var m struct {
		ID         string `json:"id"`
		ProviderID string `json:"providerID"`
	}
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return "", ""
	}
	return m.ID, m.ProviderID
}

// Message is one assistant turn with its own cost and token counts.
type Message struct {
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
	Created    int64 // unix ms
	Completed  int64 // unix ms
}

// messageData is the shape stored in message.data.
type messageData struct {
	Role       string  `json:"role"`
	ModelID    string  `json:"modelID"`
	ProviderID string  `json:"providerID"`
	Cost       float64 `json:"cost"`
	Path       struct {
		Cwd string `json:"cwd"`
	} `json:"path"`
	Tokens struct {
		Input  int64 `json:"input"`
		Output int64 `json:"output"`
		Cache  struct {
			Read  int64 `json:"read"`
			Write int64 `json:"write"`
		} `json:"cache"`
	} `json:"tokens"`
	Time struct {
		Created   int64 `json:"created"`
		Completed int64 `json:"completed"`
	} `json:"time"`
}

// Messages returns messages for one session in chronological order.
func Messages(ctx context.Context, db *sql.DB, sessionID string) ([]Message, error) {
	const q = `SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC`
	rows, err := db.QueryContext(ctx, q, sessionID)
	if err != nil {
		return nil, fmt.Errorf("opencode: messages: %w", err)
	}
	defer rows.Close()

	var out []Message
	for rows.Next() {
		var id, data string
		if err := rows.Scan(&id, &data); err != nil {
			return nil, fmt.Errorf("opencode: scan message: %w", err)
		}
		var d messageData
		if err := json.Unmarshal([]byte(data), &d); err != nil {
			// One unreadable row must not abort an import of thousands.
			continue
		}
		out = append(out, Message{
			ID: id, SessionID: sessionID, Role: d.Role,
			Model: d.ModelID, Provider: d.ProviderID, Cwd: d.Path.Cwd,
			Cost:     d.Cost,
			TokensIn: d.Tokens.Input, TokensOut: d.Tokens.Output,
			CacheRead: d.Tokens.Cache.Read, CacheWrite: d.Tokens.Cache.Write,
			Created: d.Time.Created, Completed: d.Time.Completed,
		})
	}
	return out, rows.Err()
}

// ToolCall is one tool invocation inside a message.
type ToolCall struct {
	ID        string
	MessageID string
	SessionID string
	Tool      string // Caprock-cased name, see NormalizeTool
	RawTool   string // as OpenCode wrote it
	FilePath  string // the file it touched, when it names one
	Status    string
	Start     int64 // unix ms
	End       int64 // unix ms
}

// partData is the shape stored in part.data for tool parts.
type partData struct {
	Type   string `json:"type"`
	Tool   string `json:"tool"`
	CallID string `json:"callID"`
	State  struct {
		Status string          `json:"status"`
		Input  json.RawMessage `json:"input"`
		Time   struct {
			Start int64 `json:"start"`
			End   int64 `json:"end"`
		} `json:"time"`
	} `json:"state"`
}

// ToolCalls returns the tool invocations of one session in order.
func ToolCalls(ctx context.Context, db *sql.DB, sessionID string) ([]ToolCall, error) {
	const q = `
		SELECT id, message_id, data FROM part
		WHERE session_id = ? AND json_extract(data,'$.type') = 'tool'
		ORDER BY time_created ASC`
	rows, err := db.QueryContext(ctx, q, sessionID)
	if err != nil {
		return nil, fmt.Errorf("opencode: tool calls: %w", err)
	}
	defer rows.Close()

	var out []ToolCall
	for rows.Next() {
		var id, msgID, data string
		if err := rows.Scan(&id, &msgID, &data); err != nil {
			return nil, fmt.Errorf("opencode: scan part: %w", err)
		}
		var d partData
		if err := json.Unmarshal([]byte(data), &d); err != nil {
			continue
		}
		out = append(out, ToolCall{
			ID: id, MessageID: msgID, SessionID: sessionID,
			Tool: NormalizeTool(d.Tool), RawTool: d.Tool,
			FilePath: filePathFrom(d.State.Input),
			Status:   d.State.Status,
			Start:    d.State.Time.Start, End: d.State.Time.End,
		})
	}
	return out, rows.Err()
}

// filePathFrom pulls the file a tool touched out of its input arguments.
//
// Caprock attributes spend to directories by watching which files a session
// edits, so this is what makes per-directory cost work for OpenCode too.
// OpenCode's own tools use filePath; MCP tools and future built-ins may use
// something else, hence the small set of aliases rather than one key.
func filePathFrom(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	for _, k := range []string{"filePath", "file_path", "path", "notebook_path"} {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// NormalizeTool maps an OpenCode tool name onto the Claude Code spelling.
//
// The two agents converged on the same tool vocabulary in different cases:
// OpenCode writes "bash", "read", "edit", Claude Code writes "Bash", "Read",
// "Edit". Caprock's loop detection, narration and work-kind classification all
// match on the Claude Code spelling, so normalising here means none of that
// code needs to learn about a second agent. Names with no counterpart are
// title-cased rather than dropped: an unknown tool should appear in the feed
// as itself, not vanish.
func NormalizeTool(t string) string {
	switch strings.ToLower(t) {
	case "bash":
		return "Bash"
	case "read":
		return "Read"
	case "edit":
		return "Edit"
	case "write":
		return "Write"
	case "grep":
		return "Grep"
	case "glob":
		return "Glob"
	case "list", "ls":
		return "LS"
	case "webfetch":
		return "WebFetch"
	case "websearch":
		return "WebSearch"
	case "todowrite", "todoread":
		return "TodoWrite"
	case "task":
		return "Agent"
	case "patch":
		return "Edit"
	case "question":
		return "AskUserQuestion"
	case "skill":
		return "Skill"
	case "":
		return ""
	default:
		// Preserve MCP-style names verbatim; they are already namespaced and
		// title-casing them would corrupt the namespace separator.
		if strings.Contains(t, "__") || strings.Contains(t, ".") {
			return t
		}
		return strings.ToUpper(t[:1]) + t[1:]
	}
}
