package api

import (
	"net/http"
	"strings"
	"testing"
)

// The Morning summary's switch and time travel through PUT /v1/settings as a
// patch; a time that is not HH:MM is refused, and an unrelated save leaves
// both alone.
func TestMorningSummarySettings(t *testing.T) {
	e := newEnv(t)
	var s Settings
	if code := e.get(t, "/v1/settings", &s); code != http.StatusOK || s.MorningSummary {
		t.Fatalf("GET: %d, on %v before it was turned on", code, s.MorningSummary)
	}
	if code := e.putSettings(t, map[string]any{"morning_summary": true, "morning_summary_at": "07:30"}); code != http.StatusOK {
		t.Fatalf("PUT: %d", code)
	}
	if code := e.get(t, "/v1/settings", &s); code != http.StatusOK || !s.MorningSummary || s.MorningSummaryAt != "07:30" {
		t.Fatalf("GET: %d %v %q", code, s.MorningSummary, s.MorningSummaryAt)
	}
	for _, bad := range []string{"7:30", "25:00", "", "noon"} {
		if code := e.putSettings(t, map[string]any{"morning_summary_at": bad}); code != http.StatusBadRequest {
			t.Fatalf("%q answered %d, want 400", bad, code)
		}
	}
	_ = e.putSettings(t, map[string]any{"plan_label": "Max"})
	if code := e.get(t, "/v1/settings", &s); code != http.StatusOK || !s.MorningSummary || s.MorningSummaryAt != "07:30" {
		t.Fatalf("an unrelated save changed the summary: %v %q", s.MorningSummary, s.MorningSummaryAt)
	}
}

// The test button answers 501 when the daemon has no sender.
func TestMorningTestWithoutASender(t *testing.T) {
	e := newEnv(t)
	resp, err := http.Post(e.srv.URL+"/v1/morning/test", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotImplemented {
		t.Fatalf("POST: %d, want 501", resp.StatusCode)
	}
}
