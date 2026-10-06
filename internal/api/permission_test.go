package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
)

// permAgents is fakeAgents that also knows one waiting permission prompt.
type permAgents struct {
	fakeAgents
	pending  *agents.Permission
	answered []string
}

func (p *permAgents) Permission(string) (any, bool) {
	if p.pending == nil {
		return nil, false
	}
	return p.pending, true
}

func (p *permAgents) AnswerPermission(_, id, choice string) error {
	if p.pending == nil || p.pending.ID != id {
		return agents.ErrNoPermission
	}
	if choice == "always" {
		return agents.ErrNotOnPrompt // a two-option menu on the screen
	}
	p.answered = append(p.answered, choice)
	p.pending = nil
	return nil
}

func TestPermissionEndpoints(t *testing.T) {
	e := newEnv(t)
	fa := &permAgents{fakeAgents: fakeAgents{avail: true}, pending: &agents.Permission{ID: "p1", Tool: "Bash", Detail: "date > out.txt"}}
	h := New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: fa})
	do := func(method, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/v1/agents/s1/permission", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}
	var got struct {
		Permission *agents.Permission `json:"permission"`
	}
	rr := do("GET", "")
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil || got.Permission == nil || got.Permission.Detail != "date > out.txt" {
		t.Fatalf("get: %d %s", rr.Code, rr.Body)
	}
	if rr := do("POST", `{"id":"p1","choice":"maybe"}`); rr.Code != http.StatusBadRequest {
		t.Fatalf("bad choice: %d", rr.Code)
	}
	if rr := do("POST", `{"choice":"allow"}`); rr.Code != http.StatusBadRequest {
		t.Fatalf("no id: %d", rr.Code)
	}
	// The option is not on the menu the screen shows: 422 with the reason the
	// card prints, and the prompt still waits.
	if rr := do("POST", `{"id":"p1","choice":"always"}`); rr.Code != http.StatusUnprocessableEntity ||
		!bytes.Contains(rr.Body.Bytes(), []byte("not on the prompt")) || fa.pending == nil {
		t.Fatalf("not on the prompt: %d %s", rr.Code, rr.Body)
	}
	if rr := do("POST", `{"id":"p1","choice":"deny"}`); rr.Code != http.StatusNoContent || len(fa.answered) != 1 || fa.answered[0] != "deny" {
		t.Fatalf("answer: %d %v", rr.Code, fa.answered)
	}
	// The same button again: the prompt is gone, and the caller is told.
	if rr := do("POST", `{"id":"p1","choice":"deny"}`); rr.Code != http.StatusConflict {
		t.Fatalf("stale answer: %d", rr.Code)
	}
	rr = do("GET", "")
	if !bytes.Contains(rr.Body.Bytes(), []byte(`"permission":null`)) {
		t.Fatalf("after answer: %s", rr.Body)
	}
}
