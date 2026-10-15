package api

import (
	"net/http"
	"testing"

	"github.com/dspv/caprock/internal/config"
)

// Settings → Terminal → Quick replies: PUT replaces the whole list, trimmed;
// a list past the bounds is a 400 and changes nothing.
func TestQuickRepliesSetting(t *testing.T) {
	e := newEnv(t)
	list := []map[string]string{{"label": " Continue ", "text": "Continue."}, {"label": "Lint", "text": "Run the linter."}}
	if code := e.putSettings(t, map[string]any{"quick_replies": list}); code != http.StatusOK {
		t.Fatalf("PUT: %d", code)
	}
	var st Settings
	if code := e.get(t, "/v1/settings", &st); code != http.StatusOK || len(st.QuickReplies) != 2 || st.QuickReplies[0].Label != "Continue" || st.QuickReplies[1].Text != "Run the linter." {
		t.Fatalf("GET: %d %+v", code, st.QuickReplies)
	}
	if code := e.putSettings(t, map[string]any{"quick_replies": []map[string]string{{"label": "", "text": "x"}}}); code != http.StatusBadRequest {
		t.Fatalf("an empty label answered %d", code)
	}
	if code := e.putSettings(t, map[string]any{"quick_replies": make([]config.QuickReply, config.QuickRepliesMax+1)}); code != http.StatusBadRequest {
		t.Fatalf("too many answered %d", code)
	}
	// A write that does not name them keeps them.
	if code := e.putSettings(t, map[string]any{"statusline_mode": "short"}); code != http.StatusOK {
		t.Fatalf("PUT other: %d", code)
	}
	if e.get(t, "/v1/settings", &st); len(st.QuickReplies) != 2 {
		t.Fatalf("an unrelated save changed them: %+v", st.QuickReplies)
	}
}
