package store

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"reflect"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// A series extended by what changed since is the series a whole read gives,
// batch after batch, and is extended — not read whole — through everything
// that does not move the calls generation: new rows, a hook's tool call
// linked to its message later (LinkToolCall), a tool payload compressed, the
// assistant text merged into a turn. Tool calls recorded before their model
// call, tools out of time order and past the six kept, unpriced, subagent and
// sidechain turns and a limit that drops the oldest calls are in the mix; a
// reprice and a delete move the generation and are read whole.
func TestSessionCallsExtendedMatchWhole(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	q := f.s.DB()
	at := time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC)
	rng := rand.New(rand.NewSource(7))
	usd := func(v float64) *float64 { return &v }
	msgs, keys := 0, 0
	turn := func(msg string, s int) {
		ev := event.Event{SessionID: "s", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Model: "claude-opus-5",
			Ts: at.Add(time.Duration(s) * time.Second), Tokens: &event.TokenDelta{In: 3, Out: 40, CacheRead: 900}, CostUSD: usd(0.01 * float64(s+1)),
			MsgID: msg, Key: "msg:" + msg, Payload: json.RawMessage(`{"text":"a"}`)}
		switch rng.Intn(10) {
		case 0:
			ev.CostUSD = nil // unpriced
		case 1:
			ev.AgentID = "sub" // a subagent's
		case 2:
			ev.Payload = json.RawMessage(`{"sidechain":1}`)
		}
		f.put(ev)
	}
	var unlinked []string // keys of hook tool calls waiting for their message id
	links := map[string]string{}
	tool := func(msg string, s int) {
		keys++
		key := fmt.Sprintf("pre:%d", keys)
		p, _ := json.Marshal(map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": fmt.Sprintf("echo %d %s", keys, string(make([]byte, 300)))}})
		ev := event.Event{SessionID: "s", Source: event.SourceTranscript, Kind: event.KindToolPre, Tool: []string{"Bash", "Read", "Edit"}[keys%3], MsgID: msg,
			Ts: at.Add(time.Duration(s) * time.Second), Payload: p, Key: key}
		if rng.Intn(2) == 0 { // from the hook: no message id until the transcript's copy
			ev.Source, ev.MsgID = event.SourceHook, ""
			unlinked = append(unlinked, key)
			links[key] = msg
		}
		f.put(ev)
	}
	var late []func() // model calls whose tools came a read earlier
	batch := func() {
		for _, f := range late {
			f()
		}
		late = nil
		for i := 0; i < 1+rng.Intn(4); i++ {
			msgs++
			msg, s := fmt.Sprintf("m%d", msgs), msgs*10
			early := rng.Intn(3) == 0
			if !early {
				turn(msg, s)
			}
			for k := 0; k < rng.Intn(9); k++ {
				tool(msg, s+rng.Intn(5)-2)
			}
			if early {
				late = append(late, func() { turn(msg, s) })
			}
		}
		if rng.Intn(4) == 0 { // a tool call of an earlier message, late
			tool(fmt.Sprintf("m%d", 1+rng.Intn(msgs)), msgs*10)
		}
		// Some hook calls get their message id, now or a batch later.
		var still []string
		for _, k := range unlinked {
			if rng.Intn(2) == 0 {
				if _, err := LinkToolCall(ctx, q, "s", k, links[k]); err != nil {
					t.Fatal(err)
				}
			} else {
				still = append(still, k)
			}
		}
		unlinked = still
		// The compression pass and a text merge.
		var id int64
		var plain []byte
		if err := q.QueryRowContext(ctx, `SELECT id, payload FROM events WHERE kind = 'tool.pre' AND typeof(payload) = 'text' ORDER BY random() LIMIT 1`).Scan(&id, &plain); err == nil {
			if z, ok := CompressPayload(plain); ok {
				if _, err := q.ExecContext(ctx, `UPDATE events SET payload = ? WHERE id = ?`, z, id); err != nil {
					t.Fatal(err)
				}
			}
		}
		if _, err := q.ExecContext(ctx, `UPDATE events SET payload = json_set(payload, '$.text', 'merged') WHERE id = (SELECT MAX(id) FROM events WHERE kind = 'turn.assistant')`); err != nil {
			t.Fatal(err)
		}
	}
	extended := 0
	for _, n := range []int{0, 5} {
		var prev *CallsSeries
		for round := 0; round < 40; round++ {
			batch()
			moving := round == 20 || round == 30
			switch round {
			case 20:
				if _, err := q.ExecContext(ctx, `UPDATE events SET cost_usd = 7 + ? WHERE msg_id = 'm3' AND kind = 'turn.assistant'`, n); err != nil {
					t.Fatal(err)
				}
			case 30:
				if _, err := q.ExecContext(ctx, `DELETE FROM events WHERE id = (SELECT MIN(id) FROM events WHERE kind = 'tool.pre' AND msg_id IS NOT NULL)`); err != nil {
					t.Fatal(err)
				}
			}
			got, err := ReadSessionCalls(ctx, q, "s", n, prev)
			if err != nil {
				t.Fatal(err)
			}
			want, err := ReadSessionCalls(ctx, q, "s", n, nil)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got.Calls, want.Calls) {
				t.Fatalf("n=%d round %d: extended\n%+v\nwhole\n%+v", n, round, got.Calls, want.Calls)
			}
			if prev != nil {
				if moved := got.Mark.Gen != prev.Mark.Gen; moved != moving {
					t.Fatalf("n=%d round %d: calls generation moved=%v, want %v", n, round, moved, moving)
				}
				if !moving {
					extended++
				}
			}
			prev = got
		}
	}
	if extended < 70 {
		t.Fatalf("only %d reads were extensions", extended)
	}
}
