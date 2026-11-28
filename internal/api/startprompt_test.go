package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/store"
)

// A Claude Code session Caprock started that has sent no hook 20 s on, with
// the hooks registered, reads as held at a prompt in its terminal in its
// summary — waiting on you, reason prompt — so every list built from
// summaries says it (#1118). With the hooks off, the same silence says
// nothing.
func TestASessionWithNoFirstHookReadsHeldAtAPrompt(t *testing.T) {
	ctx := context.Background()
	for _, on := range []bool{true, false} {
		e := newEnv(t)
		fa := &fakeAgents{avail: true, held: map[string]bool{"held": true, "fresh": true}}
		e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: fa, HooksOn: func() bool { return on }})
		started := map[string]time.Time{"held": e.now.Add(-narrate.StartPromptAfter - time.Second), "fresh": e.now.Add(-5 * time.Second)}
		for id, at := range started {
			if err := store.UpsertSession(ctx, e.st.DB(), id, store.SessionPatch{Cwd: t.TempDir(), StartedAt: at.UnixMilli()}); err != nil {
				t.Fatal(err)
			}
			if err := store.MarkOwned(ctx, e.st.DB(), id, "", "claude", 1); err != nil {
				t.Fatal(err)
			}
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
		a := get("held").Activity
		if on && (a.Health != narrate.HealthWaiting || a.Need == nil || a.Need.Reason != narrate.NeedStartPrompt || a.Phrase != narrate.StartPromptPhrase) {
			t.Errorf("hooks on: held reads %s %q %+v, want waiting at a prompt", a.Health, a.Phrase, a.Need)
		}
		if !on && a.Health == narrate.HealthWaiting {
			t.Errorf("hooks off: held reads waiting; silence is by design without hooks")
		}
		if f := get("fresh").Activity; f.Health == narrate.HealthWaiting {
			t.Errorf("hooks %v: a session 5 s old reads waiting", on)
		}
	}
}
