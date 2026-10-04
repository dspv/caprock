package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// survivingAgents is fakeAgents that also knows which sessions are held by a
// pty-host (ADR-033).
type survivingAgents struct {
	*fakeAgents
	hosted map[string]bool
}

func (s survivingAgents) Survives(id string) bool { return s.hosted[id] }

// The upgrade notice counts the sessions an upgrade would end. One in a
// pty-host is not among them, and the detail says which is which.
func TestSurvivesRestartMarksHostedSessions(t *testing.T) {
	e := newEnv(t)
	fa := survivingAgents{
		fakeAgents: &fakeAgents{avail: true, held: map[string]bool{"hosted": true, "inproc": true}},
		hosted:     map[string]bool{"hosted": true},
	}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: fa})
	ctx := context.Background()
	for _, id := range []string{"hosted", "inproc", "ended"} {
		if err := store.UpsertSession(ctx, e.st.DB(), id, store.SessionPatch{Cwd: t.TempDir()}); err != nil {
			t.Fatal(err)
		}
		if err := store.MarkOwned(ctx, e.st.DB(), id, "", "claude", 1); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.SetExit(ctx, e.st.DB(), "ended", 0); err != nil {
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
	if !get("hosted").SurvivesRestart {
		t.Error("a session in a pty-host is not marked as surviving a restart")
	}
	if get("inproc").SurvivesRestart {
		t.Error("a session in the daemon's own PTY is marked as surviving a restart; the upgrade notice would hide it")
	}
	if get("ended").SurvivesRestart {
		t.Error("an ended session is marked as surviving a restart")
	}
}
