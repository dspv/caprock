package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// app_update travels through PUT /v1/settings as a patch, an unknown word is
// refused, and an unrelated save leaves it alone.
func TestAppUpdateSettingValidates(t *testing.T) {
	e := newEnv(t)
	if code := e.putSettings(t, map[string]any{"app_update": "auto"}); code != http.StatusOK {
		t.Fatalf("auto: %d", code)
	}
	var s Settings
	if code := e.get(t, "/v1/settings", &s); code != http.StatusOK || s.AppUpdate != "auto" {
		t.Fatalf("GET: %d %q", code, s.AppUpdate)
	}
	for _, bad := range []string{"always", "", "AUTO"} {
		if code := e.putSettings(t, map[string]any{"app_update": bad}); code != http.StatusBadRequest {
			t.Fatalf("%q answered %d, want 400", bad, code)
		}
	}
	_ = e.putSettings(t, map[string]any{"plan_label": "Max"})
	if code := e.get(t, "/v1/settings", &s); code != http.StatusOK || s.AppUpdate != "auto" {
		t.Fatalf("an unrelated save changed app_update to %q", s.AppUpdate)
	}
}

// GET /v1/update/busy is the count the app waits on before installing an
// update by itself; nothing but the count.
func TestUpdateBusyEndpoint(t *testing.T) {
	e := newEnv(t)
	if code := e.get(t, "/v1/update/busy", nil); code != http.StatusNotImplemented {
		t.Fatalf("without a counter: %d, want 501", code)
	}
	n, fail := 2, false
	s := New(Deps{Store: e.st, Token: "tok", UpdateBusy: func(context.Context) (int, error) {
		if fail {
			return 0, errors.New("db locked")
		}
		return n, nil
	}})
	srv := httptest.NewServer(s)
	defer srv.Close()
	e2 := &env{srv: srv}
	var got map[string]any
	if code := e2.get(t, "/v1/update/busy", &got); code != http.StatusOK {
		t.Fatalf("GET: %d", code)
	}
	if len(got) != 1 || got["working"] != float64(2) {
		t.Fatalf("body = %v, want only working: 2", got)
	}
	// A failed count is an error, never a 0 that would let the app restart.
	fail = true
	if code := e2.get(t, "/v1/update/busy", nil); code < 500 {
		t.Fatalf("a failed count answered %d", code)
	}
}
