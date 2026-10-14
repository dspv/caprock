package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/store"
)

// nudgedAgents is fakeAgents that also knows the input typed into its sessions.
type nudgedAgents struct {
	*fakeAgents
	nudges map[string]narrate.Nudge
}

func (n nudgedAgents) Nudge(id string) (narrate.Nudge, bool) {
	v, ok := n.nudges[id]
	return v, ok
}

// A session's status reads the input typed into it before the session has
// written an event for it: an answered dialog reads working at once, not when
// the call it allowed finishes. A session left quiet long enough to be marked
// idle still reads working once it was set going.
func TestTheStatusReadsInputBeforeTheNextEvent(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	asked := e.now.Add(-20 * time.Minute)
	fa := nudgedAgents{
		fakeAgents: &fakeAgents{avail: true, held: map[string]bool{"owned": true}},
		nudges:     map[string]narrate.Nudge{"owned": {At: e.now.Add(-time.Second), Kind: narrate.NudgeApproved}},
	}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: fa})
	for _, id := range []string{"owned", "not-owned"} {
		if err := store.UpsertSession(ctx, e.st.DB(), id, store.SessionPatch{Cwd: t.TempDir()}); err != nil {
			t.Fatal(err)
		}
		ev := event.Event{SessionID: id, Source: event.SourceHook, Kind: event.KindPermissionPrompt, Tool: "Bash", Ts: asked,
			Payload: json.RawMessage(`{"tool_name":"Bash","tool_input":{"command":"make build"}}`)}
		if _, err := store.InsertEvent(ctx, e.st.DB(), &ev); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.MarkOwned(ctx, e.st.DB(), "owned", "", "claude", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkIdleSessions(ctx, e.st.DB(), e.now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	get := func(id string) SessionDetail {
		t.Helper()
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, httptest.NewRequest("GET", "/v1/sessions/"+id, nil))
		var d SessionDetail
		if err := json.Unmarshal(rr.Body.Bytes(), &d); err != nil {
			t.Fatalf("%s: %d %v", id, rr.Code, err)
		}
		return d
	}
	if a := get("owned").Activity; a.Health != narrate.HealthWorking || a.Phrase != "approved — running `make build`" {
		t.Errorf("owned: %s %q, want working on the approved call", a.Health, a.Phrase)
	}
	if a := get("not-owned").Activity; a.Health != narrate.HealthWaiting {
		t.Errorf("not owned: %s %q, want still waiting — nothing here saw it answered", a.Health, a.Phrase)
	}
}
