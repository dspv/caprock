package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// GET /v1/resources/history hands ?since to the daemon as unix ms, refuses
// one that is not, and answers 501 from a daemon without the history.
func TestResourceHistoryRoute(t *testing.T) {
	do := func(s *Server, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.RemoteAddr = "127.0.0.1:50000"
		r.Host = "127.0.0.1:22776"
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	if w := do(New(Deps{}), "/v1/resources/history"); w.Code != http.StatusNotImplemented {
		t.Errorf("no history: %d, want 501", w.Code)
	}
	var got []int64
	s := New(Deps{ResourceHistory: func(since int64) any {
		got = append(got, since)
		return map[string]any{"at": []int64{}}
	}})
	for _, p := range []string{"/v1/resources/history", "/v1/resources/history?since=1791400000000"} {
		if w := do(s, p); w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", p, w.Code, w.Body)
		}
	}
	for _, bad := range []string{"?since=soon", "?since=-5"} {
		if w := do(s, "/v1/resources/history"+bad); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", bad, w.Code)
		}
	}
	if len(got) != 2 || got[0] != 0 || got[1] != 1791400000000 {
		t.Errorf("since the daemon got: %v", got)
	}
}
