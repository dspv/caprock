package hooks

import (
	"path/filepath"
	"testing"
)

// InstallFor is the one path the CLI and the dashboard button share: after it,
// every event is registered in the given file (never the user's real
// ~/.claude/settings.json — a temp dir here) and the report says so.
func TestInstallForRegistersEveryEvent(t *testing.T) {
	dir := t.TempDir()
	data := filepath.Join(dir, "data")
	settings := filepath.Join(dir, "home", ".claude", "settings.json")
	st, _, err := InstallFor(data, settings)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Missing) != 0 || len(st.Installed) != len(Events) || st.SettingsPath != settings {
		t.Fatalf("after install: %+v", st)
	}
	// Twice is the same as once.
	again, _, err := InstallFor(data, settings)
	if err != nil || len(again.Missing) != 0 || len(again.Installed) != len(Events) {
		t.Fatalf("second install: %+v, %v", again, err)
	}
}
