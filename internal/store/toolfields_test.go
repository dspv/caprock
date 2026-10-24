package store

import (
	"context"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// Migration 0070 on a database whose tool calls were stored before it: the
// Tools screen and the subagent rows read the same answers from tool_fields
// as they once extracted from the payloads, and the expression index over
// the payload is gone.
func TestMigration0070MovesToolFieldsOutOfThePayload(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "caprock.db")
	s, err := Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	f := &drillFixture{t: t, s: s}
	f.call("s", "Bash", at, map[string]any{"command": "git status"}, ok(40))
	f.call("s", "Bash", at, map[string]any{"command": "go test ./..."}, failed())
	f.call("s", "Bash", at, map[string]any{"command": "go test ./..."}, nil)
	f.call("s", "Read", at, map[string]any{"file_path": "/home/u/repo/a.go"}, ok(10))
	put := func(ev event.Event) {
		t.Helper()
		if _, err := InsertEvent(ctx, s.DB(), &ev); err != nil {
			t.Fatal(err)
		}
	}
	put(event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindToolPost, Tool: "Agent", Ts: at,
		Key: "post:agent", Payload: []byte(`{"tool_response":{"agentId":"a1","description":"Fix the cockpit"}}`)})
	put(event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindToolPost, Tool: "Agent", Ts: at,
		Key: "post:bad", Payload: []byte(`{"tool_response": not json`)})

	opts := DrillOptions{Tool: "Bash", Home: "/home/u", ToMs: at.Add(time.Hour).UnixMilli()}
	bash, err := ToolDrillStats(ctx, s.DB(), opts)
	if err != nil {
		t.Fatal(err)
	}
	read, err := ToolDrillStats(ctx, s.DB(), DrillOptions{Tool: "Read", Home: "/home/u"})
	if err != nil {
		t.Fatal(err)
	}
	if len(bash.Rows) != 2 || bash.Rows[0].Key != "go test" || bash.Rows[0].Failures != 1 || bash.Failures != 1 || bash.Results != 2 ||
		len(read.Rows) != 1 || read.Rows[0].Key != "~/repo/a.go" || read.GroupBy != "file" {
		t.Fatalf("before the migration ran again: bash %+v, read %+v", bash, read)
	}

	// As migration 0070 leaves a database from before it: tool_fields empty
	// and no version recorded, so the next Open marks every call pending.
	db := s.DB()
	for _, q := range []string{
		`DELETE FROM tool_fields`,
		`DELETE FROM meta WHERE k = 'tool_fields_version'`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	_ = s.Close()
	s, err = Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db = s.DB()

	// The same answers while the older calls wait to be filled (read from
	// their payloads), after one step of the newest, and once all are.
	same := func(when string) {
		t.Helper()
		again, err := ToolDrillStats(ctx, db, opts)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(again, bash) {
			t.Fatalf("%s, the Tools screen changed:\n before %+v\n now    %+v", when, bash, again)
		}
		if r, err := ToolDrillStats(ctx, db, DrillOptions{Tool: "Read", Home: "/home/u"}); err != nil || !reflect.DeepEqual(r, read) {
			t.Fatalf("%s, Read changed: %+v (%v), was %+v", when, r, err, read)
		}
		list := []SubagentActivity{{AgentID: "a1"}}
		if err := describeSubagents(ctx, db, "s", list); err != nil || list[0].Description != "Fix the cockpit" {
			t.Fatalf("%s, description %q, %v", when, list[0].Description, err)
		}
	}
	same("before filling")
	// While results wait to be filled, their subagents are sought on the
	// old index, not read from every payload of the session.
	plan := queryPlan(t, db, `SELECT `+agentTaskDesc+` FROM events
		WHERE sid = (SELECT sid FROM sessions WHERE session_id = ?) AND kind = 'tool.post' AND tool IN ('Agent', 'Task') AND `+agentTaskID+` IN (?)`, "s", "a1")
	if !strings.Contains(plan, "idx_events_agent_task") {
		t.Fatalf("pending results are not sought on idx_events_agent_task; plan:\n%s", plan)
	}
	if _, done, err := s.ToolFieldsStep(ctx, 3); err != nil || done {
		t.Fatalf("one step of three ids: done %v, %v", done, err)
	}
	same("half filled")
	if _, err := s.FillToolFields(ctx, 3, 0); err != nil {
		t.Fatal(err)
	}
	same("filled")
	if v, _ := s.GetMeta(ctx, metaToolFieldsPending); v != "0" {
		t.Fatalf("pending = %q after filling", v)
	}
	// One row per call, one per failed result, one for the Agent result; a
	// result that succeeded or is not JSON has nothing to keep.
	var rows int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM tool_fields`).Scan(&rows); err != nil || rows != 4+1+1 {
		t.Fatalf("tool_fields rows = %d (%v), want 6", rows, err)
	}
	var idx int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE name = 'idx_events_agent_task'`).Scan(&idx); err != nil || idx != 0 {
		t.Fatalf("idx_events_agent_task still there (%d, %v)", idx, err)
	}
}

// A tool call's fields live and die with it: a deleted event takes its row,
// a payload rewritten in place is read again, and a new derivation reaches
// the calls already stored.
func TestToolFieldsFollowTheEvent(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "caprock.db")
	s, err := Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	f := &drillFixture{t: t, s: s}
	f.call("s", "Bash", at, map[string]any{"command": "make test"}, failed())
	key := func() (k string) {
		t.Helper()
		if err := s.DB().QueryRowContext(ctx, `SELECT COALESCE(f.drill_key, '?') FROM events e
			LEFT JOIN tool_fields f ON f.event_id = e.id WHERE e.kind = 'tool.pre'`).Scan(&k); err != nil {
			t.Fatal(err)
		}
		return k
	}
	if k := key(); k != "make test" {
		t.Fatalf("drill_key = %q", k)
	}

	var id int64
	if err := s.DB().QueryRowContext(ctx, `SELECT id FROM events WHERE kind = 'tool.pre'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().ExecContext(ctx, `UPDATE events SET payload = json_set(payload, '$.tool_input.command', 'git push') WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	if err := RefreshToolFields(ctx, s.DB(), id); err != nil {
		t.Fatal(err)
	}
	if k := key(); k != "git push" {
		t.Fatalf("after the payload was rewritten, drill_key = %q", k)
	}

	// Another derivation: the next Open reads every call again.
	if _, err := s.DB().ExecContext(ctx, `UPDATE tool_fields SET drill_key = 'stale' WHERE event_id = ?`, id); err != nil {
		t.Fatal(err)
	}
	if err := s.SetMeta(ctx, metaToolFields, "0"); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	if s, err = Open(ctx, path, nil); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	// Pending again: the screen reads the payload, not the stale row.
	d, err := ToolDrillStats(ctx, s.DB(), DrillOptions{Tool: "Bash"})
	if err != nil || len(d.Rows) != 1 || d.Rows[0].Key != "git push" || d.Failures != 1 {
		t.Fatalf("while re-deriving: %+v, %v", d, err)
	}
	if _, err := s.FillToolFields(ctx, 1000, 0); err != nil {
		t.Fatal(err)
	}
	if k := key(); k != "git push" {
		t.Fatalf("after a new derivation, drill_key = %q", k)
	}

	if _, err := s.DB().ExecContext(ctx, `DELETE FROM events`); err != nil {
		t.Fatal(err)
	}
	var left int
	if err := s.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM tool_fields`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("%d tool_fields rows outlived their events (%v)", left, err)
	}
}

// The Go reading agrees with what json_extract read: a string input, a
// missing one, a null file_path falling through to notebook_path, and the
// truthiness of is_error.
func TestReadToolFields(t *testing.T) {
	for _, c := range []struct {
		name, tool, payload string
		kind                event.Kind
		want                toolFields
		ok                  bool
	}{
		{"shell", "Bash", `{"cwd":"/r","tool_input":{"command":"npm run build"}}`, event.KindToolPre, toolFields{drillKey: "npm run", drillBy: "command"}, true},
		{"notebook", "NotebookEdit", `{"tool_input":{"file_path":null,"notebook_path":"/n.ipynb"}}`, event.KindToolPre, toolFields{drillKey: "/n.ipynb", drillBy: "file"}, true},
		{"codex script", "exec", `{"tool_input":"tools.exec_command({cmd: \"ls -la\"})"}`, event.KindToolPre, toolFields{drillKey: "ls", drillBy: "command"}, true},
		{"no input", "Bash", `{}`, event.KindToolPre, toolFields{drillKey: drillNotRecorded, drillBy: "call"}, true},
		{"failed", "Bash", `{"is_error":true,"tool_response":"x"}`, event.KindToolPost, toolFields{isError: true}, true},
		{"failed as 1", "Bash", `{"is_error":1}`, event.KindToolPost, toolFields{isError: true}, true},
		{"succeeded", "Bash", `{"is_error":false,"tool_response":"x"}`, event.KindToolPost, toolFields{}, false},
		{"agent", "Task", `{"tool_response":{"agentId":"a","description":"d"}}`, event.KindToolPost, toolFields{agentID: "a", agentDesc: "d"}, true},
		{"agent text", "Agent", `{"tool_response":"done"}`, event.KindToolPost, toolFields{}, false},
		{"turn", "", `{"text":"hi"}`, event.KindTurnAssistant, toolFields{}, false},
	} {
		got, ok := readToolFields(c.kind, c.tool, []byte(c.payload))
		if got != c.want || ok != c.ok {
			t.Errorf("%s: %+v %v, want %+v %v", c.name, got, ok, c.want, c.ok)
		}
	}
}
