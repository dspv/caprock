package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The orphan stop's contract: a body of pid + started_at targets, handed to
// the daemon as they came; bad bodies refused before anything is called;
// and ?orphans=1 on the footprint asks for the list.
func TestOrphanStopContract(t *testing.T) {
	var got []OrphanTarget
	var asked []bool
	s := New(Deps{
		Footprint: func(_ context.Context, orphans bool) any {
			asked = append(asked, orphans)
			return map[string]any{"ok": true}
		},
		StopOrphans: func(_ context.Context, ts []OrphanTarget) any {
			got = ts
			return map[string]any{"stopped": []any{}, "failed": []any{}}
		},
	})
	do := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:50000"
		r.Host = "127.0.0.1:22776"
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}

	do(http.MethodGet, "/v1/footprint", "")
	do(http.MethodGet, "/v1/footprint?orphans=1", "")
	if len(asked) != 2 || asked[0] || !asked[1] {
		t.Errorf("footprint asked for the list: %v, want [false true]", asked)
	}

	for _, bad := range []string{`nope`, `{}`, `{"targets":[]}`, `{"targets":[{"pid":1,"started_at":5}]}`, `{"targets":[{"pid":42}]}`} {
		if w := do(http.MethodPost, "/v1/footprint/orphans/stop", bad); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", bad, w.Code)
		}
	}
	if got != nil {
		t.Fatalf("a refused body reached the daemon: %+v", got)
	}

	w := do(http.MethodPost, "/v1/footprint/orphans/stop", `{"targets":[{"pid":4242,"started_at":1791877000000},{"pid":77,"started_at":9}]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("stop: %d %s", w.Code, w.Body)
	}
	if len(got) != 2 || got[0] != (OrphanTarget{PID: 4242, StartedAt: 1791877000000}) || got[1].PID != 77 {
		t.Errorf("targets the daemon got: %+v", got)
	}
	var res map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil || res["stopped"] == nil {
		t.Errorf("answer: %s (%v)", w.Body, err)
	}

	if w := (func() *httptest.ResponseRecorder {
		s := New(Deps{})
		r := httptest.NewRequest(http.MethodPost, "/v1/footprint/orphans/stop", strings.NewReader(`{"targets":[{"pid":4242,"started_at":1}]}`))
		r.RemoteAddr, r.Host = "127.0.0.1:50000", "127.0.0.1:22776"
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	})(); w.Code != http.StatusNotImplemented {
		t.Errorf("no stop wired: %d, want 501", w.Code)
	}
}

// A phone may read the orphan list with the footprint but never stop one,
// whatever its role.
func TestOrphanStopIsMachineOnly(t *testing.T) {
	s, _, viewer, controller := pairedPhones(t, Deps{})
	for _, dev := range []string{viewer.Token, controller.Token} {
		if got, _ := s.gate(phoneRequest("POST /v1/footprint/orphans/stop", dev)); got != http.StatusForbidden {
			t.Errorf("a paired phone: %d, want 403", got)
		}
		if got, _ := s.gate(phoneRequest("GET /v1/footprint", dev)); got != 0 {
			t.Errorf("a paired phone reading the footprint: %d, want 0", got)
		}
	}
}
