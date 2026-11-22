package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// The sessions list says which Claude Code sessions are in a turn by their
// hooks, so a row can say *no reply 2d* without reading the session's events
// (.ai/04-ui.md § Sidebar, *Stalled*). A call still running, an ended
// session and an agent without hooks never say it.
func TestSessionsListTurnOpen(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }})
	add := func(id string, ev event.Event) {
		t.Helper()
		ev.SessionID = id
		if ev.Source == "" {
			ev.Source = event.SourceHook
		}
		if _, err := store.InsertEvent(ctx, e.st.DB(), &ev); err != nil {
			t.Fatal(err)
		}
	}
	session := func(id string, p store.SessionPatch) {
		t.Helper()
		p.Cwd = t.TempDir()
		if err := store.UpsertSession(ctx, e.st.DB(), id, p); err != nil {
			t.Fatal(err)
		}
	}
	old := e.now.Add(-48 * time.Hour)
	// Stalled: a prompt two days ago, nothing since.
	session("stalled", store.SessionPatch{FromHook: true, LastEventAt: old.UnixMilli()})
	add("stalled", event.Event{Kind: event.KindAgentStop, Ts: old.Add(-time.Minute)})
	add("stalled", event.Event{Kind: event.KindTurnUser, Ts: old, Payload: json.RawMessage(`{"prompt":"fix it"}`)})
	// A call still running two days later: work, not a stall.
	session("running", store.SessionPatch{FromHook: true, LastEventAt: old.UnixMilli()})
	add("running", event.Event{Kind: event.KindTurnUser, Ts: old.Add(-time.Minute)})
	add("running", event.Event{Kind: event.KindToolPre, Tool: "Bash", Ts: old, Payload: json.RawMessage(`{"tool_use_id":"t1","tool_input":{"command":"make e2e"}}`)})
	// Answered.
	session("answered", store.SessionPatch{FromHook: true, LastEventAt: old.UnixMilli()})
	add("answered", event.Event{Kind: event.KindTurnUser, Ts: old.Add(-time.Minute)})
	add("answered", event.Event{Kind: event.KindAgentStop, Ts: old})
	// Ended with its turn open.
	session("ended", store.SessionPatch{FromHook: true, LastEventAt: old.UnixMilli(), Status: store.StatusEnded})
	add("ended", event.Event{Kind: event.KindTurnUser, Ts: old})
	// Codex: no hooks to say when a turn ends.
	session("codex", store.SessionPatch{Agent: "codex", FromTranscript: true, LastEventAt: old.UnixMilli()})
	add("codex", event.Event{Kind: event.KindTurnUser, Ts: old, Source: event.SourceTranscript})

	rr := httptest.NewRecorder()
	e.srv.Config.Handler.ServeHTTP(rr, httptest.NewRequest("GET", "/v1/sessions", nil))
	var list []SessionSummary
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatalf("%d %v: %s", rr.Code, err, rr.Body.String())
	}
	got := map[string]bool{}
	for _, s := range list {
		got[s.SessionID] = s.TurnOpen
	}
	want := map[string]bool{"stalled": true, "running": false, "answered": false, "ended": false, "codex": false}
	for id, w := range want {
		if g, ok := got[id]; !ok {
			t.Errorf("%s: not listed", id)
		} else if g != w {
			t.Errorf("%s: turn_open = %v, want %v", id, g, w)
		}
	}
}
