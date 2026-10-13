package api

import (
	"net/http"
	"testing"

	"github.com/dspv/caprock/internal/config"
)

// Settings → Status line takes the three modes and nothing else: a word the
// status line command does not know would be read back as Full, silently.
func TestStatuslineModeSettingValidates(t *testing.T) {
	e := newEnv(t)
	for _, mode := range config.StatuslineModes {
		if code := e.putSettings(t, map[string]any{"statusline_mode": mode}); code != http.StatusOK {
			t.Fatalf("%s: %d", mode, code)
		}
		var st Settings
		if code := e.get(t, "/v1/settings", &st); code != http.StatusOK || st.StatuslineMode != mode {
			t.Fatalf("GET after %s: %d %q", mode, code, st.StatuslineMode)
		}
	}
	for _, bad := range []string{"compact", ""} {
		if code := e.putSettings(t, map[string]any{"statusline_mode": bad}); code != http.StatusBadRequest {
			t.Fatalf("%q answered %d, want 400", bad, code)
		}
	}
}
