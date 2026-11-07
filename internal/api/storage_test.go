package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
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

// GET /v1/storage/pack is the daemon's report; POST starts a pack and answers
// 202 with it, or the status the daemon gives a refusal, with its reason.
func TestStoragePackEndpoints(t *testing.T) {
	var started int
	refuse := false
	s := New(Deps{
		StoragePack: func(context.Context) any { return map[string]bool{"running": started > 0} },
		StartPack: func(context.Context) (any, int, error) {
			if refuse {
				return nil, http.StatusConflict, errors.New("the database is already being packed")
			}
			started++
			return map[string]bool{"running": true}, 0, nil
		},
	})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/storage/pack", nil))
	if w.Code != http.StatusOK || w.Body.String() != "{\"running\":false}\n" {
		t.Fatalf("report: %d %q", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/storage/pack", strings.NewReader("{}"))
	r.Header.Set("Content-Type", "application/json")
	s.ServeHTTP(w, r)
	if w.Code != http.StatusAccepted || started != 1 {
		t.Fatalf("start: %d %q, started %d", w.Code, w.Body.String(), started)
	}
	refuse = true
	w = httptest.NewRecorder()
	r = httptest.NewRequest(http.MethodPost, "/v1/storage/pack", strings.NewReader("{}"))
	r.Header.Set("Content-Type", "application/json")
	s.ServeHTTP(w, r)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "already being packed") {
		t.Fatalf("refused: %d %q", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	New(Deps{}).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/storage/pack", nil))
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("unwired: %d", w.Code)
	}
}
