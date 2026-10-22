package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// A subagent's spend is its own turns' cost, under the model it last ran;
// one turn the table could not price makes it, and the total, unknown — not
// a smaller number. A subagent with no turn has no spend at all.
func TestSubagentsSpend(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	at := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	usd := func(v float64) *float64 { return &v }
	turn := func(sess, agent, model string, s int, cost *float64) {
		f.put(event.Event{SessionID: sess, AgentID: agent, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Model: model,
			Ts: at.Add(time.Duration(s) * time.Second), Tokens: &event.TokenDelta{In: 1}, CostUSD: cost})
	}
	turn("s", "", "claude-opus-5", 0, usd(9)) // the main thread is not a subagent
	turn("s", "a", "claude-sonnet-5", 1, usd(0.5))
	turn("s", "a", "claude-haiku-4-5", 2, usd(0.25))
	turn("s", "a", "codex-auto-review", 3, nil) // internal: left out, not "unpriced"
	turn("s", "b", "claude-haiku-4-5", 1, usd(0.1))
	f.put(event.Event{SessionID: "s", AgentID: "c", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Read", Ts: at})

	by, total, err := SubagentsSpend(ctx, f.s.DB(), "s")
	if err != nil {
		t.Fatal(err)
	}
	if a := by["a"]; a.Model != "claude-haiku-4-5" || !a.Known || a.CostUSD != 0.75 {
		t.Fatalf("a = %+v", a)
	}
	if _, ok := by["c"]; ok {
		t.Fatalf("c has no turn and no spend: %+v", by["c"])
	}
	if !total.Known || total.CostUSD < 0.849 || total.CostUSD > 0.851 {
		t.Fatalf("total = %+v; want 0.85 known", total)
	}

	turn("s", "b", "claude-haiku-4-5", 5, nil)
	by, total, err = SubagentsSpend(ctx, f.s.DB(), "s")
	if err != nil {
		t.Fatal(err)
	}
	if by["b"].Known || total.Known || !by["a"].Known {
		t.Fatalf("an unpriced turn must make b and the total unknown: b=%+v total=%+v", by["b"], total)
	}
	if _, total, _ := SubagentsSpend(ctx, f.s.DB(), "none"); total.Known {
		t.Fatalf("a session with no subagent turn has no known total")
	}
}

// queryPlan is EXPLAIN QUERY PLAN's details, one per line.
func queryPlan(t *testing.T, q Querier, query string, args ...any) string {
	t.Helper()
	rows, err := q.QueryContext(context.Background(), `EXPLAIN QUERY PLAN `+query, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	plan := ""
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		plan += detail + "\n"
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return plan
}

// A subagent's description comes off idx_tool_fields_agent without opening
// a payload. A result whose payload is not JSON is still stored, and one in
// another session names nobody here.
func TestDescribeSubagentsReadsTheIndex(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	at := time.Date(2026, 10, 14, 1, 0, 0, 0, time.UTC)
	post := func(session, key, payload string) {
		f.put(event.Event{SessionID: session, Source: event.SourceHook, Kind: event.KindToolPost, Tool: "Agent",
			Key: key, Ts: at, Payload: []byte(payload)})
	}
	post("s", "post:1", `{"tool_response":{"agentId":"a","description":"Fix the cockpit"}}`)
	post("s", "post:2", `{"tool_response":{"agentId":"b","description":"Read the log"}}`)
	post("s", "post:3", `{"tool_response": not json`)
	post("other", "post:4", `{"tool_response":{"agentId":"c","description":"Not this session's"}}`)
	var n int
	if err := f.s.DB().QueryRow(`SELECT COUNT(*) FROM events WHERE kind = 'tool.post'`).Scan(&n); err != nil || n != 4 {
		t.Fatalf("stored %d Agent results (%v); a payload that is not JSON must still be stored", n, err)
	}

	list := []SubagentActivity{{AgentID: "a"}, {AgentID: "b"}, {AgentID: "c"}}
	if err := describeSubagents(ctx, f.s.DB(), "s", list); err != nil {
		t.Fatal(err)
	}
	if list[0].Description != "Fix the cockpit" || list[1].Description != "Read the log" || list[2].Description != "" {
		t.Fatalf("descriptions = %q, %q, %q", list[0].Description, list[1].Description, list[2].Description)
	}

	plan := queryPlan(t, f.s.DB(), `SELECT f.agent_desc FROM tool_fields f INDEXED BY idx_tool_fields_agent
		JOIN events e ON e.id = f.event_id
		WHERE f.agent_id IN (?) AND e.session_id = ? AND e.kind = 'tool.post'`, "a", "s")
	if !strings.Contains(plan, "COVERING INDEX idx_tool_fields_agent (agent_id=?)") {
		t.Fatalf("the agent id is not sought on idx_tool_fields_agent; plan:\n%s", plan)
	}
}

// The live-subagent counts and a subagent's spend read their covering
// indexes (migration 0054), not the session's rows from the table.
func TestSubagentCountsAreCovered(t *testing.T) {
	db := openTest(t).DB()
	for _, c := range []struct{ name, query string }{
		{"live", `SELECT agent_id, MAX(ts), MAX(CASE WHEN kind = 'agent.stop' THEN ts ELSE 0 END) FROM events
			WHERE session_id = 's' AND ts >= 0 AND agent_id IS NOT NULL AND agent_id <> '' GROUP BY agent_id`},
		{"spend", `SELECT agent_id, MAX(ts), COALESCE(model, ''), COUNT(*), SUM(cost_usd IS NULL AND tokens_in IS NOT NULL), COALESCE(SUM(cost_usd), 0)
			FROM events INDEXED BY idx_events_subagent_turn
			WHERE session_id = 's' AND kind = 'turn.assistant' AND agent_id IS NOT NULL AND agent_id <> '' AND internal = 0 GROUP BY agent_id`},
	} {
		if plan := queryPlan(t, db, c.query); !strings.Contains(plan, "COVERING INDEX") {
			t.Errorf("%s reads the table; plan:\n%s", c.name, plan)
		}
	}
}
