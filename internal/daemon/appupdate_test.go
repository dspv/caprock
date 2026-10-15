package daemon

import (
	"context"
	"testing"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/config"
)

// The app's update mode is "ask" until chosen, is not written down by a save
// that only echoes the default, survives a restart once chosen, and an
// empty value in a write keeps the choice.
func TestAppUpdateSettingDefaultsAndPersists(t *testing.T) {
	dir := t.TempDir()
	d := &Daemon{log: quietLog(), opt: Options{DataDir: dir}, baseCtx: context.Background()}
	a := &settingsAdapter{d: d}

	if got := a.Get().AppUpdate; got != config.AppUpdateAsk {
		t.Fatalf("default app_update = %q, want ask", got)
	}
	if err := a.Set(a.Get()); err != nil {
		t.Fatal(err)
	}
	if d.opt.Config.AppUpdate != "" {
		t.Fatalf("an unchanged default was stored as %q", d.opt.Config.AppUpdate)
	}
	in := a.Get()
	in.AppUpdate = config.AppUpdateAuto
	if err := a.Set(in); err != nil {
		t.Fatal(err)
	}
	saved, err := config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if saved.AppUpdate != config.AppUpdateAuto || a.Get().AppUpdate != config.AppUpdateAuto {
		t.Fatalf("auto did not persist: disk %q, get %q", saved.AppUpdate, a.Get().AppUpdate)
	}
	if err := a.Set(api.Settings{AppUpdate: ""}); err != nil {
		t.Fatal(err)
	}
	if a.Get().AppUpdate != config.AppUpdateAuto {
		t.Fatal("an empty app_update reset the choice")
	}
	in = a.Get()
	in.AppUpdate = config.AppUpdateAsk
	if err := a.Set(in); err != nil {
		t.Fatal(err)
	}
	if a.Get().AppUpdate != config.AppUpdateAsk {
		t.Fatal("back to ask did not stick")
	}
}
