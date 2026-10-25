package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// GET /v1/system/memory: the machine reads it with the other apps, a paired
// phone reads it too but told it is one (the daemon then leaves the apps'
// names out). POST /v1/system/memory/end-idle is the machine's alone, and a
// bad body never reaches the daemon.
func TestSystemMemoryAuth(t *testing.T) {
	var pairedAsks []bool
	var ended [][]string
	var fronts []string
	var restarted []string
	s, _, viewer, controller := pairedPhones(t, Deps{
		RestartEnd: func(_ context.Context, id string) any {
			restarted = append(restarted, id)
			return map[string]any{"ended": true}
		},
		SystemMemory: func(_ context.Context, paired bool, front string) any {
			pairedAsks = append(pairedAsks, paired)
			fronts = append(fronts, front)
			return map[string]any{"ok": true}
		},
		EndIdleAgents: func(_ context.Context, ids []string, front string) any {
			ended = append(ended, ids)
			fronts = append(fronts, front)
			return map[string]any{"ended": ids}
		},
	})
	local := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:50000"
		r.Host = "127.0.0.1:22776"
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	if w := local(http.MethodGet, "/v1/system/memory?front=tab-1", ""); w.Code != http.StatusOK {
		t.Fatalf("machine GET: %d %s", w.Code, w.Body)
	}
	for _, dev := range []string{viewer.Token, controller.Token} {
		if code, why := s.gate(phoneRequest("GET /v1/system/memory", dev)); code != 0 {
			t.Fatalf("a paired phone may read the totals: %d %s", code, why)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, phoneRequest("GET /v1/system/memory", dev))
		if w.Code != http.StatusOK {
			t.Fatalf("phone GET: %d %s", w.Code, w.Body)
		}
		if code, _ := s.gate(phoneRequest("POST /v1/system/memory/end-idle", dev)); code != http.StatusForbidden {
			t.Fatalf("a paired phone ending agents: %d, want 403", code)
		}
		if code, _ := s.gate(phoneRequest("POST /v1/system/memory/restart", dev)); code != http.StatusForbidden {
			t.Fatalf("a paired phone restarting an agent: %d, want 403", code)
		}
	}
	if len(pairedAsks) != 3 || pairedAsks[0] || !pairedAsks[1] || !pairedAsks[2] {
		t.Fatalf("paired flags the daemon got: %v, want [false true true]", pairedAsks)
	}

	for _, bad := range []string{`nope`, `{}`, `{"session_ids":[]}`} {
		if w := local(http.MethodPost, "/v1/system/memory/end-idle", bad); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", bad, w.Code)
		}
	}
	if ended != nil {
		t.Fatalf("a refused body reached the daemon: %v", ended)
	}
	if w := local(http.MethodPost, "/v1/system/memory/end-idle", `{"session_ids":["a","b"],"front":"tab-2"}`); w.Code != http.StatusOK {
		t.Fatalf("end-idle: %d %s", w.Code, w.Body)
	}
	if len(ended) != 1 || len(ended[0]) != 2 || ended[0][0] != "a" {
		t.Fatalf("ids the daemon got: %v", ended)
	}
	// The tab in front reaches the daemon from the query and from the body.
	if len(fronts) < 2 || fronts[0] != "tab-1" || fronts[len(fronts)-1] != "tab-2" {
		t.Fatalf("front the daemon got: %v", fronts)
	}

	for _, bad := range []string{`nope`, `{}`, `{"session_id":""}`} {
		if w := local(http.MethodPost, "/v1/system/memory/restart", bad); w.Code != http.StatusBadRequest {
			t.Errorf("restart %s: %d, want 400", bad, w.Code)
		}
	}
	if restarted != nil {
		t.Fatalf("a refused restart reached the daemon: %v", restarted)
	}
	if w := local(http.MethodPost, "/v1/system/memory/restart", `{"session_id":"a"}`); w.Code != http.StatusOK || len(restarted) != 1 || restarted[0] != "a" {
		t.Fatalf("restart: %d %s %v", w.Code, w.Body, restarted)
	}

	bare := New(Deps{})
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/v1/system/memory", nil)
	r.RemoteAddr, r.Host = "127.0.0.1:50000", "127.0.0.1:22776"
	bare.ServeHTTP(w, r)
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("without the meter: %d, want 501", w.Code)
	}
}
