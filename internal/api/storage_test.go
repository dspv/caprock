package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// GET /v1/storage hands back whatever the daemon's report says, and is a 501
// rather than a crash in a build that wired none.
func TestStorageEndpoint(t *testing.T) {
	s := New(Deps{Storage: func(context.Context) any { return map[string]int{"total_bytes": 42} }})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/storage", nil))
	if w.Code != http.StatusOK || w.Body.String() != "{\"total_bytes\":42}\n" {
		t.Fatalf("served: %d %q", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	New(Deps{}).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/storage", nil))
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("unwired: %d", w.Code)
	}
}
