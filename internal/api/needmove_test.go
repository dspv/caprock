package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/store"
)

// A turn Caprock read as Done can be moved to Needs you by hand, and back;
// the move holds until the session's next turn ends.
func TestANeedMoveHoldsForItsTurn(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }})
	if err := store.UpsertSession(ctx, e.st.DB(), "s1", store.SessionPatch{Cwd: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	add := func(ev event.Event) {
		t.Helper()
		ev.SessionID, ev.Source = "s1", event.SourceHook
		if _, err := store.InsertEvent(ctx, e.st.DB(), &ev); err != nil {
			t.Fatal(err)
		}
	}
	get := func() narrate.Activity {
		t.Helper()
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, httptest.NewRequest("GET", "/v1/sessions/s1", nil))
		var d SessionDetail
		if err := json.Unmarshal(rr.Body.Bytes(), &d); err != nil {
			t.Fatalf("%d %v", rr.Code, err)
		}
		return d.Activity
	}
	move := func(body string) int {
		t.Helper()
		rr := httptest.NewRecorder()
		req := httptest.NewRequest("PUT", "/v1/sessions/s1/needs", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		e.srv.Config.Handler.ServeHTTP(rr, req)
		return rr.Code
	}

	add(event.Event{Kind: event.KindTurnUser, Ts: e.now.Add(-3 * time.Minute)})
	if code := move(`{"needs":true}`); code != 409 {
		t.Fatalf("move mid-turn: %d, want 409", code)
	}
	add(event.Event{Kind: event.KindAgentStop, Ts: e.now.Add(-2 * time.Minute), Payload: json.RawMessage(`{"last_assistant_message":"Pushed the branch."}`)})
	if a := get(); a.Health != narrate.HealthDone || a.Need == nil || !a.Need.Guess {
		t.Fatalf("before: %+v need=%+v", a, a.Need)
	}
	if code := move(`{}`); code != 400 {
		t.Fatalf("empty body: %d, want 400", code)
	}
	if code := move(`{"needs":true}`); code != 200 {
		t.Fatalf("move: %d", code)
	}
	if a := get(); a.Health != narrate.HealthWaiting || a.Need == nil || !a.Need.Moved {
		t.Fatalf("after needs me: %+v need=%+v", a, a.Need)
	}
	if code := move(`{"needs":false}`); code != 200 {
		t.Fatalf("move back: %d", code)
	}
	if a := get(); a.Health != narrate.HealthDone {
		t.Fatalf("after not needed: %+v", a)
	}
	if code := move(`{"needs":true}`); code != 200 {
		t.Fatal("move again")
	}
	// The next turn reads afresh.
	add(event.Event{Kind: event.KindTurnUser, Ts: e.now.Add(-time.Minute)})
	add(event.Event{Kind: event.KindAgentStop, Ts: e.now.Add(-30 * time.Second), Payload: json.RawMessage(`{"last_assistant_message":"Done again."}`)})
	if a := get(); a.Health != narrate.HealthDone || a.Need.Moved {
		t.Fatalf("next turn: %+v need=%+v", a, a.Need)
	}
}
