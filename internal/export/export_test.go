package export

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

var base = time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)

// fixture builds a real database through the store's migrations, fills it with
// two agents' sessions, closes it (the daemon is down) and returns its path.
// The directory has a space in it, as macOS's "Application Support" does.
func fixture(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "Application Support", "caprock")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "caprock.db")
	ctx := context.Background()
	st, err := store.Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	db := st.DB()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	ms := func(d time.Duration) int64 { return base.Add(d).UnixMilli() }
	exec(`INSERT INTO sessions (session_id, cwd, project, model, started_at, last_event_at, status, agent, repo_root, title)
	      VALUES ('c1', '/w/api', 'api', 'claude-opus-5-5', ?, ?, 'ended', 'claude', '/w/api', 'Fix the "login"	bug')`, ms(0), ms(time.Hour))
	exec(`INSERT INTO sessions (session_id, cwd, project, model, started_at, last_event_at, status, agent)
	      VALUES ('x1', '/w/web', 'web', 'gpt-6', ?, ?, 'ended', 'codex')`, ms(48*time.Hour), ms(49*time.Hour))
	exec(`INSERT INTO sessions (session_id, cwd, project, model, started_at, last_event_at, status, agent)
	      VALUES ('r1', '/w/web', 'web', 'codex-auto-review', ?, ?, 'ended', 'codex')`, ms(50*time.Hour), ms(50*time.Hour))
	exec(`INSERT INTO events (ts, session_id, source, kind, tool, payload, tool_bytes, touch_dir)
	      VALUES (?, 'c1', 'hook', 'tool.pre', 'Bash', '{"command":"go test\t./...\nok"}', 0, 'svc\api')`, ms(time.Minute))
	exec(`INSERT INTO events (ts, session_id, source, kind, payload, tokens_in, tokens_out, cache_read, cache_write, cost_usd, model, msg_id)
	      VALUES (?, 'c1', 'transcript', 'turn.assistant', '{}', 10, 200, 5000, 300, 0.0425, 'claude-opus-5-5', 'msg_1')`, ms(2*time.Minute))
	exec(`INSERT INTO events (ts, session_id, source, kind, payload, tokens_in, tokens_out, cost_usd, model)
	      VALUES (?, 'x1', 'codex', 'turn.assistant', '{}', 50, 60, 0.01, 'gpt-6')`, ms(48*time.Hour))
	exec(`INSERT INTO events (ts, session_id, source, kind, payload, model, internal)
	      VALUES (?, 'r1', 'codex', 'turn.assistant', '{}', 'codex-auto-review', 1)`, ms(50*time.Hour))
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func run(t *testing.T, path string, o Options) (string, int64) {
	t.Helper()
	db, err := OpenReadOnly(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var buf bytes.Buffer
	n, err := Write(context.Background(), db, &buf, o)
	if err != nil {
		t.Fatal(err)
	}
	return buf.String(), n
}

func TestEventsTSV(t *testing.T) {
	out, n := run(t, fixture(t), Options{})
	if n != 3 {
		t.Fatalf("rows = %d, want 3 (the review turn is internal and left out)\n%s", n, out)
	}
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) != 4 {
		t.Fatalf("lines = %d, want header + 3: a cell must never break a line\n%s", len(lines), out)
	}
	head := strings.Split(lines[0], "\t")
	if head[0] != "ts" || head[2] != "agent" || len(head) != len(eventCols) {
		t.Fatalf("header = %v", head)
	}
	first := strings.Split(lines[1], "\t")
	if len(first) != len(head) {
		t.Fatalf("row has %d cells, header %d", len(first), len(head))
	}
	if first[0] != "2026-09-01T12:01:00.000Z" || first[2] != "claude" || first[6] != "Bash" {
		t.Fatalf("first row = %v", first)
	}
	// A backslash in a value is escaped, so it cannot be read as an escape.
	if first[15] != `svc\\api` {
		t.Fatalf("touch_dir = %q, want escaped backslash", first[15])
	}
	second := strings.Split(lines[2], "\t")
	if second[13] != "0.0425" || second[10] != "5000" || second[18] != "msg_1" {
		t.Fatalf("second row = %v", second)
	}
	if strings.Contains(out, "codex-auto-review") {
		t.Fatal("internal event exported")
	}
	if strings.Contains(out, "go test") {
		t.Fatal("payload exported without --payload")
	}
}

func TestFilters(t *testing.T) {
	path := fixture(t)
	cases := []struct {
		name string
		o    Options
		want int64
	}{
		{"agent", Options{Agent: "codex"}, 1},
		{"since", Options{Since: base.Add(24 * time.Hour)}, 1},
		{"since and agent", Options{Since: base.Add(24 * time.Hour), Agent: "claude"}, 0},
		{"sessions", Options{Table: "sessions"}, 2},
		{"sessions by agent", Options{Table: "sessions", Agent: "claude"}, 1},
		{"sessions since", Options{Table: "sessions", Since: base.Add(24 * time.Hour)}, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, n := run(t, path, c.o)
			if n != c.want {
				t.Fatalf("rows = %d, want %d", n, c.want)
			}
		})
	}
}

func TestSessionsCSV(t *testing.T) {
	out, _ := run(t, fixture(t), Options{Table: "sessions", Format: "csv"})
	recs, err := csv.NewReader(strings.NewReader(out)).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 3 {
		t.Fatalf("records = %d, want header + 2", len(recs))
	}
	// The title keeps its quotes and tab intact through CSV quoting.
	if recs[1][13] != "Fix the \"login\"\tbug" {
		t.Fatalf("title = %q", recs[1][13])
	}
	// worked_at was never set: empty, not 1970.
	if recs[1][11] != "" {
		t.Fatalf("worked_at = %q, want empty", recs[1][11])
	}
}

func TestJSONLPayload(t *testing.T) {
	out, n := run(t, fixture(t), Options{Format: "jsonl", Payload: true, Agent: "claude"})
	if n != 2 {
		t.Fatalf("rows = %d", n)
	}
	first := strings.SplitN(out, "\n", 2)[0]
	var m map[string]any
	if err := json.Unmarshal([]byte(first), &m); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, first)
	}
	p, ok := m["payload"].(map[string]any)
	if !ok || !strings.Contains(p["command"].(string), "go test") {
		t.Fatalf("payload not embedded as JSON: %v", m["payload"])
	}
	if m["tokens_in"] != nil {
		t.Fatalf("tokens_in = %v, want null", m["tokens_in"])
	}
	if !strings.HasPrefix(first, `{"ts":`) {
		t.Fatalf("keys out of column order: %s", first[:20])
	}
}

func TestRejects(t *testing.T) {
	path := fixture(t)
	db, err := OpenReadOnly(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, o := range []Options{
		{Table: "turns"},
		{Format: "xlsx"},
		{Agent: "cursor"},
		{Payload: true}, // tsv
		{Table: "sessions", Format: "jsonl", Payload: true},
	} {
		if _, err := Write(context.Background(), db, &bytes.Buffer{}, o); err == nil {
			t.Errorf("%+v: want an error", o)
		}
	}
}

// Read-only means read-only: a write through the handle must fail.
func TestOpenReadOnlyCannotWrite(t *testing.T) {
	db, err := OpenReadOnly(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`DELETE FROM events`); err == nil {
		t.Fatal("delete succeeded on a read-only handle")
	}
}

func TestParseSince(t *testing.T) {
	now := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	for in, want := range map[string]time.Time{
		"":    {},
		"30d": now.AddDate(0, 0, -30),
		"12h": now.Add(-12 * time.Hour),
		"0d":  now,
	} {
		got, err := ParseSince(in, now)
		if err != nil || !got.Equal(want) {
			t.Errorf("%q: got %v, %v; want %v", in, got, err, want)
		}
	}
	got, err := ParseSince("2026-09-01", now)
	if err != nil || got.Year() != 2026 || got.Month() != 9 || got.Day() != 1 {
		t.Errorf("date: got %v, %v", got, err)
	}
	for _, bad := range []string{"yesterday", "-3d", "3x"} {
		if _, err := ParseSince(bad, now); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
}

// A tab inside a value is written as \t, so the row keeps its column count.
func TestTSVEscapesTabInTitle(t *testing.T) {
	out, _ := run(t, fixture(t), Options{Table: "sessions"})
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("lines = %d, want 3", len(lines))
	}
	cells := strings.Split(lines[1], "\t")
	if len(cells) != len(sessionCols) || cells[13] != `Fix the "login"\tbug` {
		t.Fatalf("cells = %d, title = %q", len(cells), cells[13])
	}
}
