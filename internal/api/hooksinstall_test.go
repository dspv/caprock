package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/store"
)

func hooksServer(t *testing.T, install func(context.Context) (any, error)) *httptest.Server {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tb, _ := cost.Embedded()
	s := New(Deps{Store: st, Bus: bus.New(), Table: tb, Version: "test", Now: time.Now,
		Status: func(context.Context) any { return map[string]string{} }, InstallHooks: install})
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return srv
}

// The Install button runs the daemon's install and answers with what is
// registered afterwards; a daemon that cannot install says so with a 501, and
// a failed install is an error, never a quiet 200.
func TestInstallHooksEndpoint(t *testing.T) {
	calls := 0
	srv := hooksServer(t, func(context.Context) (any, error) {
		calls++
		return map[string]any{"hooks": map[string]any{"missing": []string{}, "settings_path": "/tmp/x/settings.json"}}, nil
	})
	resp, err := http.Post(srv.URL+"/v1/hooks/install", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Hooks struct {
			SettingsPath string `json:"settings_path"`
		} `json:"hooks"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || calls != 1 || body.Hooks.SettingsPath != "/tmp/x/settings.json" {
		t.Fatalf("install: status %d, calls %d, body %+v", resp.StatusCode, calls, body)
	}

	failing := hooksServer(t, func(context.Context) (any, error) { return nil, errors.New("settings.json is not JSON") })
	resp, err = http.Post(failing.URL+"/v1/hooks/install", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode < 400 {
		t.Fatalf("a failed install answered %d", resp.StatusCode)
	}

	none := hooksServer(t, nil)
	resp, err = http.Post(none.URL+"/v1/hooks/install", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotImplemented {
		t.Fatalf("no installer: got %d, want 501", resp.StatusCode)
	}
}
