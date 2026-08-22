package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeTasks is a Phase 2 TaskController that records calls and can be made to
// error, so the API-layer wiring (routes, path values, status codes, the 409
// error path) is exercised without a real hive.
type fakeTasks struct {
	approvals   []string // "id:approve" / "id:reject"
	verified    []string
	started     bool
	stopped     int
	failVerify  bool
	failApprove bool
	// off makes Enabled report the task runner as not yet turned on, which is
	// how every task endpoint answers 501 without the controller being nil.
	off       bool
	failEnabl bool
	enabled   []string // "hive|repo" per Enable call
}

func (f *fakeTasks) Enabled() bool { return !f.off }

func (f *fakeTasks) Enable(_ context.Context, hive, repo string) (any, error) {
	if f.failEnabl {
		return nil, errors.New("the task runner is already on (hive: /elsewhere)")
	}
	if hive == "" {
		hive = "/home/u/caprock-tasks"
	}
	if repo == "" {
		repo = "/repo"
	}
	f.enabled = append(f.enabled, hive+"|"+repo)
	f.off = false
	return map[string]string{"hive": hive, "repo": repo}, nil
}

func (f *fakeTasks) List(context.Context) (any, error)              { return []any{}, nil }
func (f *fakeTasks) Create(_ context.Context, req any) (any, error) { return req, nil }
func (f *fakeTasks) Get(_ context.Context, id string) (any, error) {
	return map[string]string{"id": id}, nil
}
func (f *fakeTasks) Approvals(context.Context) (any, error) { return []any{}, nil }
func (f *fakeTasks) Approve(_ context.Context, id string, approve bool) error {
	if f.failApprove {
		return errors.New("cannot approve")
	}
	tag := ":reject"
	if approve {
		tag = ":approve"
	}
	f.approvals = append(f.approvals, id+tag)
	return nil
}
func (f *fakeTasks) StartOrchestrator(context.Context) (any, error) {
	f.started = true
	return map[string]string{"session_id": "orch-1"}, nil
}
func (f *fakeTasks) StopOrchestrator(context.Context) (any, error) {
	f.stopped++
	return map[string]int{"stopped": 3}, nil
}
func (f *fakeTasks) Verify(_ context.Context, id string) (any, error) {
	if f.failVerify {
		return nil, errors.New("verify blew up")
	}
	f.verified = append(f.verified, id)
	return map[string]any{"task_id": id, "passed": true, "status": "done"}, nil
}

func newTasksSrv(t *testing.T, ft *fakeTasks) func(method, path, body string) *http.Response {
	e := newEnv(t)
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok",
		Now: func() time.Time { return e.now }, Tasks: ft})
	return func(method, path, body string) *http.Response {
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		// Real clients (the dashboard, `caprock task create`, curl) all send a
		// JSON content type; the origin guard requires it on a state-changing
		// request that carries no other proof of provenance. See csrf.go.
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		return rr.Result()
	}
}

func TestPhase2Endpoints(t *testing.T) {
	ft := &fakeTasks{}
	do := newTasksSrv(t, ft)

	if r := do("POST", "/v1/tasks", `{"id":"t1","title":"x"}`); r.StatusCode != 200 {
		t.Fatalf("create: %d", r.StatusCode)
	}
	if r := do("GET", "/v1/tasks/t1", ""); r.StatusCode != 200 {
		t.Fatalf("get: %d", r.StatusCode)
	}
	if r := do("POST", "/v1/tasks/t1/verify", ""); r.StatusCode != 200 || len(ft.verified) != 1 || ft.verified[0] != "t1" {
		t.Fatalf("verify: %d %v", r.StatusCode, ft.verified)
	}
	if r := do("POST", "/v1/orchestrator/start", ""); r.StatusCode != 200 || !ft.started {
		t.Fatalf("orchestrator start: %d started=%v", r.StatusCode, ft.started)
	}
	// Approve AND reject — both paths, previously only approve was covered anywhere.
	if r := do("POST", "/v1/tasks/t1/approve", ""); r.StatusCode != 204 {
		t.Fatalf("approve: %d", r.StatusCode)
	}
	if r := do("POST", "/v1/tasks/t1/reject", ""); r.StatusCode != 204 {
		t.Fatalf("reject: %d", r.StatusCode)
	}
	if len(ft.approvals) != 2 || ft.approvals[0] != "t1:approve" || ft.approvals[1] != "t1:reject" {
		t.Fatalf("approvals not recorded: %v", ft.approvals)
	}
}

// A controller error surfaces as HTTP 409, not a 200 or a panic.
func TestPhase2EndpointsErrorPath(t *testing.T) {
	do := newTasksSrv(t, &fakeTasks{failVerify: true})
	if r := do("POST", "/v1/tasks/t1/verify", ""); r.StatusCode != http.StatusConflict {
		t.Fatalf("verify error should be 409, got %d", r.StatusCode)
	}
}

// With orchestration off (Tasks nil), every Phase 2 endpoint returns 501.
func TestPhase2EndpointsDisabled(t *testing.T) {
	e := newEnv(t) // no Tasks wired
	do := func(method, path string) int {
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		return rr.Result().StatusCode
	}
	for _, p := range []struct{ m, path string }{
		{"GET", "/v1/tasks"},
		{"POST", "/v1/tasks/t1/verify"},
		{"POST", "/v1/orchestrator/start"},
		{"POST", "/v1/orchestrator/stop"},
		{"GET", "/v1/approvals"},
	} {
		if code := do(p.m, p.path); code != http.StatusNotImplemented {
			t.Fatalf("%s %s: want 501, got %d", p.m, p.path, code)
		}
	}
}

// The task runner can now be turned on over a running daemon, so "off" is no
// longer the same thing as "no controller wired": the controller outlives the
// off state and answers Enabled() instead. Every task endpoint must still be
// 501 while it is off, or the dashboard would render a board over a hive that
// does not exist.
func TestTaskEndpointsAreOffUntilTheRunnerIsEnabled(t *testing.T) {
	ft := &fakeTasks{off: true}
	do := newTasksSrv(t, ft)
	if code := do("GET", "/v1/tasks", "").StatusCode; code != http.StatusNotImplemented {
		t.Fatalf("GET /v1/tasks with the runner off: want 501, got %d", code)
	}
	if code := do("POST", "/v1/orchestrator/start", "").StatusCode; code != http.StatusNotImplemented {
		t.Fatalf("orchestrator start with the runner off: want 501, got %d", code)
	}
	if ft.started {
		t.Fatal("the orchestrator was spawned while the task runner was off")
	}
}

// The off state used to hand the user a command to paste into a terminal,
// because a flag at startup was the only way in. Turning it on is a request now,
// and it must reach the daemon with the paths the user confirmed.
func TestEnableHiveTurnsTheRunnerOn(t *testing.T) {
	ft := &fakeTasks{off: true}
	do := newTasksSrv(t, ft)
	r := do("POST", "/v1/hive", `{"hive":"/tmp/q","repo":"/tmp/repo"}`)
	if r.StatusCode != 200 {
		t.Fatalf("POST /v1/hive: %d — the runner cannot be turned on without a restart", r.StatusCode)
	}
	if len(ft.enabled) != 1 || ft.enabled[0] != "/tmp/q|/tmp/repo" {
		t.Fatalf("Enable got %v, want the confirmed hive and repo", ft.enabled)
	}
	var body map[string]string
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["hive"] != "/tmp/q" || body["repo"] != "/tmp/repo" {
		t.Fatalf("the reply does not name what was opened: %v", body)
	}
	// And the endpoints it gates are live immediately — no restart.
	if code := do("GET", "/v1/tasks", "").StatusCode; code != 200 {
		t.Fatalf("GET /v1/tasks after enabling: want 200, got %d", code)
	}
}

// An empty body means "use the daemon's own suggestion", which is what the
// dashboard shows in its confirmation. It must not be a 400.
func TestEnableHiveWithNoBodyUsesTheSuggestion(t *testing.T) {
	ft := &fakeTasks{off: true}
	do := newTasksSrv(t, ft)
	if code := do("POST", "/v1/hive", "").StatusCode; code != 200 {
		t.Fatalf("POST /v1/hive with no body: want 200, got %d", code)
	}
	if len(ft.enabled) != 1 || ft.enabled[0] != "/home/u/caprock-tasks|/repo" {
		t.Fatalf("Enable got %v, want the daemon's suggestion", ft.enabled)
	}
}

// Turning it on twice over a different directory would leave the first board's
// router running against task files nobody is looking at. It is a conflict.
func TestEnableHiveTwiceIsAConflict(t *testing.T) {
	do := newTasksSrv(t, &fakeTasks{failEnabl: true})
	r := do("POST", "/v1/hive", `{"hive":"/tmp/q"}`)
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("enabling twice: want 409, got %d", r.StatusCode)
	}
	var body map[string]string
	_ = json.NewDecoder(r.Body).Decode(&body)
	if !strings.Contains(body["error"], "already on") {
		t.Fatalf("the 409 does not say why: %v", body)
	}
}

// Defect regression (panel finding 8): there was no stop-everything control. The
// only way to halt an unattended fleet was POST /v1/agents/{id}/signal, per
// agent, for session ids the user had no list of. One call must reach the
// orchestrator and every worker it spawned.
func TestStopOrchestratorEndpoint(t *testing.T) {
	ft := &fakeTasks{}
	do := newTasksSrv(t, ft)
	r := do("POST", "/v1/orchestrator/stop", "")
	if r.StatusCode != 200 {
		t.Fatalf("stop: %d — there is no single call that stops orchestration", r.StatusCode)
	}
	if ft.stopped != 1 {
		t.Fatalf("StopOrchestrator called %d times, want 1", ft.stopped)
	}
	var body map[string]int
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["stopped"] != 3 {
		t.Fatalf("stop count not reported: %v", body)
	}
}

// The per-agent signal 400 names the FIELD, not only the values: a caller who
// sent the right verb under the wrong key was previously left guessing.
func TestAgentSignalErrorNamesTheField(t *testing.T) {
	e := newEnv(t)
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok",
		Now: func() time.Time { return e.now }, Agents: &fakeAgents{avail: true}})
	req := httptest.NewRequest("POST", "/v1/agents/s1/signal", bytes.NewBufferString(`{"signal":"kill"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	e.srv.Config.Handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "action") {
		t.Fatalf("the 400 does not name the field: %q", rr.Body.String())
	}
}
