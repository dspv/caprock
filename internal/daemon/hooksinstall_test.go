package daemon

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/loop"
	"github.com/dspv/caprock/internal/store"
)

// The owner clicked Install hooks on a preview, saw "Hooks installed ✓",
// reloaded, and the banner said all nine events were missing. The install
// had registered the fallback `"<exe>" hook` (no caprock-hook beside the
// binary) and /v1/status checked against the data-dir shim path, which
// recognises that fallback only when the executable is named caprock.
//
// This runs the real wiring under a test binary — whose name is not caprock,
// exactly the failing case — with HOME and USERPROFILE in a temp dir, so the
// user's own ~/.claude/settings.json is never touched: install through the
// API, then read /v1/status through the API, and nothing may be missing.
func TestInstallThenStatusAgreeThroughTheAPI(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()
	d := &Daemon{
		store: st, log: log, bus: bus.New(), baseCtx: ctx,
		mgr:   agents.NewManager(st, t.TempDir(), "", log),
		opt:   Options{Config: config.Defaults(), DataDir: t.TempDir()},
		table: &cost.Table{}, det: loop.New(5, time.Minute),
		start: time.Now(),
	}
	tb, _ := cost.Embedded()
	srv := httptest.NewServer(api.New(api.Deps{Store: st, Bus: bus.New(), Table: tb, Version: "test", Now: time.Now,
		Status: d.status, InstallHooks: d.installHooks}))
	t.Cleanup(srv.Close)

	missing := func() []string {
		t.Helper()
		resp, err := http.Get(srv.URL + "/v1/status")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		var s struct {
			Hooks struct {
				SettingsPath string   `json:"settings_path"`
				Missing      []string `json:"missing"`
			} `json:"hooks"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
			t.Fatal(err)
		}
		if want := filepath.Join(home, ".claude", "settings.json"); s.Hooks.SettingsPath != want {
			t.Fatalf("status checked %q, not the temp home's %q", s.Hooks.SettingsPath, want)
		}
		return s.Hooks.Missing
	}

	if len(missing()) == 0 {
		t.Fatal("a fresh home reported no missing hooks")
	}
	resp, err := http.Post(srv.URL+"/v1/hooks/install", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("install answered %d", resp.StatusCode)
	}
	if m := missing(); len(m) != 0 {
		t.Fatalf("after install, /v1/status still reports missing: %v", m)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "settings.json")); err != nil {
		t.Fatalf("install wrote nothing to the temp home: %v", err)
	}
}
