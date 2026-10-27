package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// openAtSchema builds a database at schema version from the real migration
// files, as a release of that version left it.
func openAtSchema(t *testing.T, version int) (string, *sql.DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "c.db")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(ON)")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	migs, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migs[:version] {
		if _, err := db.Exec(m.sql); err != nil {
			t.Fatalf("apply %s: %v", m.name, err)
		}
	}
	if _, err := db.Exec(`INSERT INTO meta(k, v) VALUES(?, ?)`, MetaSchemaVersion, version); err != nil {
		t.Fatal(err)
	}
	return path, db
}

func TestSessionSidMigrationKeepsEverySessionsEvents(t *testing.T) {
	ctx := context.Background()
	path, db := openAtSchema(t, 72)
	for _, stmt := range []string{
		`INSERT INTO sessions(session_id, started_at, last_event_at, status) VALUES ('late', 3000, 3000, 'active'), ('early', 1000, 1000, 'active')`,
		`INSERT INTO session_stats(session_id, turns) VALUES ('early', 2)`,
		// 'orphan' has events and no row of its own, as some older versions left it.
		`INSERT INTO events(ts, session_id, source, kind, payload, key) VALUES
			(1000, 'early', 'hook', 'turn.user', '{}', 'k'),
			(2000, 'orphan', 'hook', 'turn.user', '{}', 'k'),
			(2500, 'orphan', 'hook', 'turn.assistant', '{}', NULL),
			(3000, 'late', 'hook', 'turn.user', '{}', 'k')`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	_ = db.Close()

	st, err := Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	rows, err := st.DB().Query(`SELECT s.sid, s.session_id, e.ts FROM events e JOIN sessions s USING (sid) ORDER BY e.id`)
	if err != nil {
		t.Fatal(err)
	}
	type row struct {
		sid int64
		id  string
		ts  int64
	}
	var got []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.sid, &r.id, &r.ts); err != nil {
			t.Fatal(err)
		}
		got = append(got, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	_ = rows.Close()
	want := []row{{1, "early", 1000}, {2, "orphan", 2000}, {2, "orphan", 2500}, {3, "late", 3000}}
	if len(got) != len(want) {
		t.Fatalf("events after the migration: %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("events after the migration: %v, want %v", got, want)
		}
	}

	var status string
	var started, last int64
	if err := st.DB().QueryRow(`SELECT status, started_at, last_event_at FROM sessions WHERE session_id = 'orphan'`).Scan(&status, &started, &last); err != nil {
		t.Fatal(err)
	}
	if status != StatusEnded || started != 2000 || last != 2500 {
		t.Fatalf("orphan's new row: %s %d-%d", status, started, last)
	}
	var turns int
	if err := st.DB().QueryRow(`SELECT turns FROM session_stats WHERE session_id = 'early'`).Scan(&turns); err != nil || turns != 2 {
		t.Fatalf("session_stats lost in the rebuild: %d %v", turns, err)
	}
	if err := st.DB().QueryRow(`SELECT 1 FROM pragma_foreign_key_check`).Scan(new(int)); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("a foreign key is broken after the migration: %v", err)
	}
	dup := &event.Event{SessionID: "late", Source: event.SourceHook, Kind: event.KindTurnUser, Key: "k",
		Payload: json.RawMessage(`{}`), Ts: time.UnixMilli(4000)}
	if _, err := InsertEvent(ctx, st.DB(), dup); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("a key stored before the migration inserted again: %v", err)
	}
}

func TestInsertEventGivesASessionWithNoRowABareOne(t *testing.T) {
	st := openTest(t)
	ev := &event.Event{SessionID: "nowhere", Source: event.SourceHook, Kind: event.KindTurnUser, Ts: time.UnixMilli(1000)}
	if _, err := InsertEvent(context.Background(), st.DB(), ev); err != nil {
		t.Fatal(err)
	}
	var started, last int64
	var status string
	err := st.DB().QueryRow(`SELECT started_at, last_event_at, status FROM sessions JOIN events USING (sid) WHERE session_id = 'nowhere'`).
		Scan(&started, &last, &status)
	if err != nil || started != 1000 || last != 1000 || status != StatusActive {
		t.Fatalf("the event's session: %d-%d %s (%v)", started, last, status, err)
	}
}

// rollup.Recorder.apply upserts a session's first event after InsertEvent has
// given it a bare row, and the row must come out as the upsert alone writes it.
func TestUpsertOverABareRowWritesWhatAnInsertWould(t *testing.T) {
	ctx := context.Background()
	repo := t.TempDir()
	pkg := filepath.Join(repo, "pkg")
	for _, d := range []string{filepath.Join(repo, ".git"), pkg} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for name, p := range map[string]SessionPatch{
		"main thread": {Cwd: pkg, TranscriptPath: "t.jsonl", GitBranch: "main", Version: "2.1.0", Model: "claude-opus-5",
			Agent: "claude", PID: 42, Title: "a title", Subscription: "max", FromHook: true, WorkedAt: 1000},
		"subagent":    {Cwd: pkg, FromSubagent: true, SubagentModel: "claude-haiku-5", FromTranscript: true},
		"outside":     {Cwd: t.TempDir(), FromTranscript: true},
		"session end": {Status: StatusEnded, FromHook: true, ParentSession: "parent"},
	} {
		p.StartedAt, p.LastEventAt = 1000, 1000
		alone, bare := openTest(t), openTest(t)
		if err := UpsertSession(ctx, alone.DB(), "s", p); err != nil {
			t.Fatal(err)
		}
		if _, err := InsertEvent(ctx, bare.DB(), &event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindTurnUser, Ts: time.UnixMilli(1000)}); err != nil {
			t.Fatal(err)
		}
		if err := UpsertSession(ctx, bare.DB(), "s", p); err != nil {
			t.Fatal(err)
		}
		if a, b := sessionRow(t, alone), sessionRow(t, bare); a != b {
			t.Errorf("%s:\n upsert alone %s\n over a bare  %s", name, a, b)
		}
	}
}

func sessionRow(t *testing.T, st *Store) string {
	t.Helper()
	rows, err := st.DB().Query(`SELECT * FROM sessions WHERE session_id = 's'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	if !rows.Next() {
		t.Fatalf("no session row (%v)", rows.Err())
	}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	for i, c := range cols {
		fmt.Fprintf(&b, "%s=%v ", c, vals[i])
	}
	return b.String()
}
