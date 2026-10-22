package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/store"
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

// GET /v1/tabs answers with the reported list as it came, and the sessions
// among it in the same order; a file's key, an unknown id and a shell are
// not rows. A paired phone, viewer or controller, may read it.
func TestGetTabsKeepsTheStripOrder(t *testing.T) {
	e := newEnv(t)
	if code := e.get(t, "/v1/tabs", nil); code != http.StatusNotImplemented {
		t.Fatalf("without a keeper: %d, want 501", code)
	}
	known := false
	reported := []string{"b", "file:/x.md", "sh-1", "gone", "a"}
	e.api.d.LatestTabs = func() ([]string, int64, bool) {
		if !known {
			return nil, 0, false
		}
		return reported, 1234, true
	}
	e.api.d.Shells = &fakeShells{}
	var ans TabsAnswer
	if code := e.get(t, "/v1/tabs", &ans); code != http.StatusOK || ans.Known || ans.Sessions == nil || ans.Items == nil || len(ans.Items) != 0 {
		t.Fatalf("nothing reported: %d %+v", code, ans)
	}
	ctx := context.Background()
	for i, id := range []string{"a", "b", "sh-1"} {
		if err := store.UpsertSession(ctx, e.st.DB(), id, store.SessionPatch{Agent: "claude", StartedAt: int64(1000 + i), LastEventAt: int64(5000 - i)}); err != nil {
			t.Fatal(err)
		}
	}
	known = true
	ans = TabsAnswer{}
	if code := e.get(t, "/v1/tabs", &ans); code != http.StatusOK || !ans.Known || ans.At != 1234 {
		t.Fatalf("GET: %d %+v", code, ans)
	}
	if !slices.Equal(ans.Sessions, reported) {
		t.Fatalf("sessions %v, want %v", ans.Sessions, reported)
	}
	var rows []string
	for _, s := range ans.Items {
		rows = append(rows, s.SessionID)
	}
	if !slices.Equal(rows, []string{"b", "a"}) {
		t.Fatalf("rows %v, want [b a]", rows)
	}

	s, _, viewer, controller := pairedPhones(t, e.api.d)
	for _, tok := range []string{viewer.Token, controller.Token} {
		r := phoneRequest("GET /v1/tabs", tok)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		var got TabsAnswer
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &got) != nil || len(got.Items) != 2 || got.Items[0].SessionID != "b" {
			t.Fatalf("a paired phone: %d %s", w.Code, w.Body)
		}
	}
	if got, _ := s.gate(phoneRequest("PUT /v1/tabs", viewer.Token)); got != http.StatusForbidden {
		t.Fatalf("a viewer phone may report tabs: %d", got)
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
