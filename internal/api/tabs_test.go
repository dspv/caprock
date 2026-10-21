package api

import (
	"bytes"
	"net/http"
	"slices"
	"strings"
	"testing"
)

func putTabs(t *testing.T, e *env, body string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, e.srv.URL+"/v1/tabs", bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

// PUT /v1/tabs hands the viewer's whole list on, trimmed and once each, and
// refuses a request with no viewer or too many sessions.
func TestPutTabsKeepsTheViewersList(t *testing.T) {
	e := newEnv(t)
	if code := putTabs(t, e, `{"viewer":"v1","sessions":["a"]}`); code != http.StatusNotImplemented {
		t.Fatalf("without a keeper: %d, want 501", code)
	}
	var gotViewer string
	var got []string
	e.api.d.OpenTabs = func(viewer string, ids []string) error { gotViewer, got = viewer, ids; return nil }
	if code := putTabs(t, e, `{"viewer":"v1","sessions":["a"," b ","a",""]}`); code != http.StatusNoContent {
		t.Fatalf("PUT: %d", code)
	}
	if gotViewer != "v1" || !slices.Equal(got, []string{"a", "b"}) {
		t.Fatalf("kept %q %v", gotViewer, got)
	}
	if code := putTabs(t, e, `{"viewer":"v1","sessions":[]}`); code != http.StatusNoContent || len(got) != 0 {
		t.Fatalf("an empty list: %d %v", code, got)
	}
	many := `{"viewer":"v1","sessions":["` + strings.Repeat(`x","`, maxTabSessions) + `y"]}`
	for _, bad := range []string{`{"sessions":["a"]}`, `{"viewer":"` + strings.Repeat("v", 65) + `"}`, many, `nope`} {
		if code := putTabs(t, e, bad); code != http.StatusBadRequest {
			t.Fatalf("%.40s answered %d, want 400", bad, code)
		}
	}
}

func TestEndIdleSettingValidates(t *testing.T) {
	e := newEnv(t)
	for _, ok := range []string{"2h", "12h", "24h", "never"} {
		if code := e.putSettings(t, map[string]any{"end_idle_after": ok}); code != http.StatusOK {
			t.Fatalf("%q: %d", ok, code)
		}
	}
	var st Settings
	if code := e.get(t, "/v1/settings", &st); code != http.StatusOK || st.EndIdleAfter != "never" {
		t.Fatalf("GET: %d %q", code, st.EndIdleAfter)
	}
	for _, bad := range []string{"1h", "", "off"} {
		if code := e.putSettings(t, map[string]any{"end_idle_after": bad}); code != http.StatusBadRequest {
			t.Fatalf("%q answered %d, want 400", bad, code)
		}
	}
}
