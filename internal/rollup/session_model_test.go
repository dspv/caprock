package rollup

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// A session run on Opus whose subagent runs on Haiku is an Opus session. The
// subagent's turn used to overwrite sessions.model, so the card, the session
// lists and the context window all said Haiku. Its cost still counts toward the
// session and the day, by its own model.
func TestASubagentTurnDoesNotRenameItsSession(t *testing.T) {
	ctx := context.Background()
	r, _ := newRecorder(t)
	at := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	info := SessionInfo{Cwd: "/home/u/proj"}
	rec := func(ev *event.Event) Result {
		t.Helper()
		res, err := r.Record(ctx, ev, info)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	rec(&event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:main1", Ts: at,
		Model: "claude-opus-5", Tokens: &event.TokenDelta{In: 1_000_000}, Payload: json.RawMessage(`{"sidechain":false}`)})

	// Three ways a subagent's events are marked, each on its own: a Claude Code
	// sidechain turn (agent id and payload flag), a turn carrying only the
	// payload flag, and a hook fired inside a subagent (agent id only).
	rec(&event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:sub1", Ts: at.Add(time.Second),
		AgentID: "a1", Model: "claude-haiku-4-5", Tokens: &event.TokenDelta{In: 1_000_000}, Payload: json.RawMessage(`{"sidechain":true}`)})
	rec(&event.Event{SessionID: "s1", Source: event.SourceCodex, Kind: event.KindTurnAssistant, Key: "msg:sub2", Ts: at.Add(2 * time.Second),
		Model: "claude-haiku-4-5", Tokens: &event.TokenDelta{In: 1_000_000}, Payload: json.RawMessage(`{"sidechain":true}`)})
	res := rec(&event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Read", Key: "pre:t1", Ts: at.Add(3 * time.Second),
		AgentID: "a1", Model: "claude-haiku-4-5", Payload: json.RawMessage(`{"tool_name":"Read"}`)})

	if res.Session.Model != "claude-opus-5" {
		t.Fatalf("session model = %q after subagent turns, want the main thread's claude-opus-5", res.Session.Model)
	}
	// Opus 5 input is $5/M, Haiku 4.5 $1/M: 5 + 1 + 1.
	if res.Stats.Turns != 3 || res.Stats.CostUSD != 7.0 {
		t.Fatalf("subagent turns must still count toward the session: %+v", res.Stats)
	}
	daily, err := store.Daily(ctx, r.Store.DB(), "2026-08-18")
	if err != nil {
		t.Fatal(err)
	}
	byModel := map[string]float64{}
	for _, d := range daily {
		byModel[d.Model] += d.CostUSD
	}
	if byModel["claude-opus-5"] != 5.0 || byModel["claude-haiku-4-5"] != 2.0 {
		t.Fatalf("daily spend must stay split by each turn's own model: %+v", byModel)
	}

	// The main thread switching model still renames the session.
	res = rec(&event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:main2", Ts: at.Add(4 * time.Second),
		Model: "claude-sonnet-5", Tokens: &event.TokenDelta{In: 10}, Payload: json.RawMessage(`{"sidechain":false}`)})
	if res.Session.Model != "claude-sonnet-5" {
		t.Fatalf("a main-thread /model switch must still rename the session, got %q", res.Session.Model)
	}
}

// A session whose every turn is a subagent's — an OpenCode child session — has
// no main thread to name it, so its subagent turns do; a model is better than
// none for its card and its context window.
func TestASubagentOnlySessionTakesItsSubagentsModel(t *testing.T) {
	ctx := context.Background()
	r, _ := newRecorder(t)
	at := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	res, err := r.Record(ctx, &event.Event{SessionID: "child", Source: event.SourceOpenCode, Kind: event.KindTurnAssistant, Key: "oc-msg:1", Ts: at,
		Model: "claude-haiku-4-5", Tokens: &event.TokenDelta{In: 10}, Payload: json.RawMessage(`{"sidechain":true}`)}, SessionInfo{Cwd: "/home/u/proj"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Session.Model != "claude-haiku-4-5" {
		t.Fatalf("subagent-only session model = %q, want claude-haiku-4-5", res.Session.Model)
	}
}

// Rows written before the fix keep the subagent's model until repaired. The
// repair takes each session's latest main-thread turn, leaves sessions with
// none alone, and runs once.
func TestRepairSessionModelsRestoresTheMainThreadsModel(t *testing.T) {
	ctx := context.Background()
	r, _ := newRecorder(t)
	db := r.Store.DB()
	at := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	for _, ev := range []*event.Event{
		{SessionID: "wrong", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:m0", Ts: at,
			Model: "claude-sonnet-5", Tokens: &event.TokenDelta{In: 10}, Payload: json.RawMessage(`{"sidechain":false}`)},
		{SessionID: "wrong", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:m1", Ts: at.Add(time.Second),
			Model: "claude-opus-5", Tokens: &event.TokenDelta{In: 10}, Payload: json.RawMessage(`{"sidechain":false}`)},
		{SessionID: "wrong", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:s1", Ts: at.Add(2 * time.Second),
			AgentID: "a1", Model: "claude-haiku-4-5", Tokens: &event.TokenDelta{In: 10}, Payload: json.RawMessage(`{"sidechain":true}`)},
		{SessionID: "child", Source: event.SourceOpenCode, Kind: event.KindTurnAssistant, Key: "oc-msg:1", Ts: at,
			Model: "claude-haiku-4-5", Tokens: &event.TokenDelta{In: 10}, Payload: json.RawMessage(`{"sidechain":true}`)},
		{SessionID: "right", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:r1", Ts: at,
			Model: "claude-opus-5", Tokens: &event.TokenDelta{In: 10}, Payload: json.RawMessage(`{"sidechain":false}`)},
	} {
		if _, err := r.Record(ctx, ev, SessionInfo{Cwd: "/home/u/proj"}); err != nil {
			t.Fatal(err)
		}
	}
	// What an earlier version stored: the subagent's model.
	if _, err := db.ExecContext(ctx, `UPDATE sessions SET model = 'claude-haiku-4-5' WHERE session_id = 'wrong'`); err != nil {
		t.Fatal(err)
	}

	n, err := r.RepairSessionModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("repaired %d sessions, want 1", n)
	}
	want := map[string]string{"wrong": "claude-opus-5", "child": "claude-haiku-4-5", "right": "claude-opus-5"}
	for id, m := range want {
		s, err := store.GetSession(ctx, db, id)
		if err != nil {
			t.Fatal(err)
		}
		if s.Model != m {
			t.Errorf("%s: model %q, want %q", id, s.Model, m)
		}
	}

	// Once: a second run touches nothing, even a row that is wrong again.
	if _, err := db.ExecContext(ctx, `UPDATE sessions SET model = 'claude-haiku-4-5' WHERE session_id = 'wrong'`); err != nil {
		t.Fatal(err)
	}
	if n, err := r.RepairSessionModels(ctx); err != nil || n != 0 {
		t.Fatalf("second run: %d %v, want 0", n, err)
	}
}
