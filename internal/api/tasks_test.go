package api

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
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
	failVerify  bool
	failApprove bool
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
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		return rr.Result().StatusCode
	}
	for _, p := range []struct{ m, path string }{
		{"GET", "/v1/tasks"},
		{"POST", "/v1/tasks/t1/verify"},
		{"POST", "/v1/orchestrator/start"},
		{"GET", "/v1/approvals"},
	} {
		if code := do(p.m, p.path); code != http.StatusNotImplemented {
			t.Fatalf("%s %s: want 501, got %d", p.m, p.path, code)
		}
	}
}
