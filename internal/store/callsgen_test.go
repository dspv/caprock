package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// The generations after migration 0091: compressing a payload moves neither;
// every other update moves gen, as every reader keyed on it needs; calls_gen
// moves only when a column the session's calls read changed, or on a delete
// or a move — never for a hook's tool call getting its message id, which the
// calls read again themselves (CallsSeries).
func TestCallsGenMovesOnlyForWhatTheCallsRead(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	db := s.DB()
	type gens struct{ gen, calls int64 }
	read := func(id string) gens {
		t.Helper()
		var g gens
		_ = db.QueryRowContext(ctx, `SELECT gen, calls_gen FROM session_gen WHERE session_id = ?`, id).Scan(&g.gen, &g.calls)
		return g
	}
	now := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	cost := 0.5
	put := func(ev *event.Event) int64 {
		t.Helper()
		id, err := InsertEvent(ctx, db, ev)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	turn := put(&event.Event{SessionID: "a", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: now, Key: "msg:m1",
		MsgID: "m1", CostUSD: &cost, Payload: json.RawMessage(`{"text":"hi"}`)})
	big := `{"tool_name":"Bash","tool_input":{"command":"` + strings.Repeat("echo hello; ", 200) + `"}}`
	pre := put(&event.Event{SessionID: "a", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash", Ts: now, Key: "pre:t1",
		Payload: json.RawMessage(big)})
	post := put(&event.Event{SessionID: "a", Source: event.SourceHook, Kind: event.KindToolPost, Tool: "Bash", Ts: now, Key: "post:t1",
		Payload: json.RawMessage(big)})
	put(&event.Event{SessionID: "b", Source: event.SourceHook, Kind: event.KindToolPre, Ts: now, Key: "pre:b", Payload: json.RawMessage(`{}`)})
	exec := func(sql string, args ...any) func() {
		return func() {
			t.Helper()
			if _, err := db.ExecContext(ctx, sql, args...); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Both sessions have a row in session_gen before the steps.
	exec(`UPDATE events SET tool_bytes = 1 WHERE key IN ('post:t1', 'pre:b')`)()
	a, b := read("a"), read("b")
	step := func(name string, change func(), wantGen, wantCalls bool) {
		t.Helper()
		change()
		na := read("a")
		if (na.gen != a.gen) != wantGen || (na.calls != a.calls) != wantCalls {
			t.Fatalf("%s: %+v -> %+v, want gen moved=%v calls moved=%v", name, a, na, wantGen, wantCalls)
		}
		if nb := read("b"); nb != b {
			t.Fatalf("%s moved b: %+v -> %+v", name, b, nb)
		}
		a = na
	}
	compress := func(id int64) func() {
		return func() {
			t.Helper()
			var plain []byte
			if err := db.QueryRowContext(ctx, `SELECT payload FROM events WHERE id = ?`, id).Scan(&plain); err != nil {
				t.Fatal(err)
			}
			z, ok := CompressPayload(plain)
			if !ok {
				t.Fatal("not compressible")
			}
			exec(`UPDATE events SET payload = ? WHERE id = ?`, z, id)()
		}
	}
	step("compress a tool call", compress(pre), false, false)
	step("compress a tool result", compress(post), false, false)
	step("link the hook's tool call", func() {
		if ok, err := LinkToolCall(ctx, db, "a", "pre:t1", "m1"); err != nil || !ok {
			t.Fatalf("link: %v %v", ok, err)
		}
	}, true, false)
	step("merge text into the turn", exec(`UPDATE events SET payload = '{"text":"hi there"}' WHERE id = ?`, turn), true, false)
	step("result rewritten", exec(`UPDATE events SET payload = '{"tool_response":"x"}' WHERE id = ?`, post), true, false)
	step("touch_dir filled on the tool call", exec(`UPDATE events SET touch_dir = '/x' WHERE id = ?`, pre), true, false)
	step("restore the compressed tool call", exec(`UPDATE events SET payload = zjson(payload) WHERE id = ?`, pre), true, true)
	step("reprice the turn", exec(`UPDATE events SET cost_usd = 0.75 WHERE id = ?`, turn), true, true)
	step("the turn becomes a sidechain", exec(`UPDATE events SET payload = '{"text":"hi there","sidechain":1}' WHERE id = ?`, turn), true, true)
	step("the tool call's input changes", exec(`UPDATE events SET payload = '{"tool_input":{"command":"ls"}}' WHERE id = ?`, pre), true, true)
	step("the tool call's message id changes", exec(`UPDATE events SET msg_id = 'm2' WHERE id = ?`, pre), true, true)
	step("a turn's agent changes", exec(`UPDATE events SET agent_id = 'x' WHERE id = ?`, turn), true, true)
	step("delete", exec(`DELETE FROM events WHERE id = ?`, post), true, true)

	// A row moved to another session moves both.
	exec(`UPDATE events SET sid = (SELECT sid FROM sessions WHERE session_id = 'b') WHERE id = ?`, pre)()
	if na, nb := read("a"), read("b"); na.gen == a.gen || na.calls == a.calls || nb.gen == b.gen || nb.calls == b.calls {
		t.Fatalf("move: a %+v -> %+v, b %+v -> %+v", a, na, b, nb)
	}
}
