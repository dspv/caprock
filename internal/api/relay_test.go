package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// The relay brief is built from what Caprock holds about the session, and a
// relay spawn that cannot be what the user asked for is refused with a reason.
func TestRelayBriefAndSpawnChecks(t *testing.T) {
	e := newEnv(t)
	fa := &fakeAgents{avail: true}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: fa})
	ctx := context.Background()
	dir := t.TempDir()
	e.note(t, "src", strings.Repeat("Halfway through the migration; next is the backfill. ", 10), e.now.Add(-time.Hour))
	if err := store.UpsertSession(ctx, e.st.DB(), "src", store.SessionPatch{Cwd: dir}); err != nil {
		t.Fatal(err)
	}

	do := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		return rr
	}

	rr := do("GET", "/v1/sessions/src/relay", "")
	if rr.Code != 200 {
		t.Fatalf("brief: %d %s", rr.Code, rr.Body)
	}
	var b struct {
		Text      string `json:"text"`
		CwdExists bool   `json:"cwd_exists"`
		PRs       []any  `json:"prs"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &b)
	if !b.CwdExists || !strings.Contains(b.Text, "> Halfway through the migration") || b.PRs == nil {
		t.Errorf("brief = %+v", b)
	}
	if rr := do("GET", "/v1/sessions/nope/relay", ""); rr.Code != 404 {
		t.Errorf("unknown session brief: %d", rr.Code)
	}

	for name, body := range map[string]string{
		"relay and resume":  `{"relay_from":"src","resume":"src","prompt":"x"}`,
		"unknown source":    `{"relay_from":"nope","prompt":"x"}`,
		"brief too long":    `{"relay_from":"src","prompt":"` + strings.Repeat("a", 8001) + `"}`,
		"prompt and resume": `{"resume":"other","prompt":"x"}`,
	} {
		if rr := do("POST", "/v1/agents", body); rr.Code != 400 {
			t.Errorf("%s: %d, want 400", name, rr.Code)
		}
	}
	if rr := do("POST", "/v1/agents", `{"cwd":"/tmp/x","relay_from":"src","agent":"codex","prompt":"carry on"}`); rr.Code != 200 {
		t.Fatalf("relay spawn: %d %s", rr.Code, rr.Body)
	}
}

// Both pages name the other end of a relay.
func TestSessionDetailNamesBothEndsOfARelay(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.note(t, "a", "first", e.now.Add(-2*time.Hour))
	e.note(t, "b", "second", e.now.Add(-time.Hour))
	if err := store.UpsertSession(ctx, e.st.DB(), "b", store.SessionPatch{Agent: "codex"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetRelayFrom(ctx, e.st.DB(), "b", "a"); err != nil {
		t.Fatal(err)
	}
	var a, b struct {
		RelayFrom   string            `json:"relay_from"`
		RelayedFrom *store.RelayLink  `json:"relayed_from"`
		RelayedTo   []store.RelayLink `json:"relayed_to"`
	}
	if c := e.get(t, "/v1/sessions/a", &a); c != http.StatusOK {
		t.Fatalf("a: %d", c)
	}
	if c := e.get(t, "/v1/sessions/b", &b); c != http.StatusOK {
		t.Fatalf("b: %d", c)
	}
	if len(a.RelayedTo) != 1 || a.RelayedTo[0].SessionID != "b" || a.RelayedTo[0].Agent != "codex" || a.RelayedFrom != nil {
		t.Errorf("a: %+v", a)
	}
	if b.RelayFrom != "a" || b.RelayedFrom == nil || b.RelayedFrom.SessionID != "a" || len(b.RelayedTo) != 0 {
		t.Errorf("b: %+v", b)
	}
}
