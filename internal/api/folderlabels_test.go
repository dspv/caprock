package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// Folder labels (ADR-091): set, replaced and removed on the machine; a body
// that names no label, a label outside work and personal, or a relative path
// is refused.
func TestFolderLabelsRoundTrip(t *testing.T) {
	e := newEnv(t)
	dir := filepath.ToSlash(filepath.Join(t.TempDir(), "acme"))
	var got FolderLabels
	if code := e.send(t, http.MethodPut, "/v1/folder-labels", `{"dir":"`+dir+`","label":"work"}`, &got); code != 200 {
		t.Fatalf("set: %d", code)
	}
	if len(got.Labels) != 1 || got.Labels[0].Label != "work" || got.Labels[0].Dir != filepath.Clean(filepath.FromSlash(dir)) {
		t.Fatalf("after set: %+v", got)
	}
	if code := e.send(t, http.MethodPut, "/v1/folder-labels", `{"dir":"`+dir+`","label":"personal"}`, &got); code != 200 || got.Labels[0].Label != "personal" {
		t.Fatalf("replace: %d %+v", code, got)
	}
	for name, body := range map[string]string{
		"no label":       `{"dir":"` + dir + `"}`,
		"another label":  `{"dir":"` + dir + `","label":"secret"}`,
		"a relative dir": `{"dir":"dev/acme","label":"work"}`,
		"no dir":         `{"label":"work"}`,
	} {
		if code := e.send(t, http.MethodPut, "/v1/folder-labels", body, nil); code != 400 {
			t.Errorf("%s: %d, want 400", name, code)
		}
	}
	if code := e.send(t, http.MethodPut, "/v1/folder-labels", `{"dir":"`+dir+`","label":""}`, &got); code != 200 || len(got.Labels) != 0 {
		t.Fatalf("remove: %d %+v", code, got)
	}
}

// A phone labels folders under home only; a viewer reads the labels and sets
// none.
func TestAPhoneLabelsFoldersUnderHome(t *testing.T) {
	home := fakeHome(t)
	inside := filepath.Join(home, "dev", "acme")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	s, _, viewer, controller := pairedPhones(t, Deps{Store: st})
	do := func(method, token, body string) int {
		r := httptest.NewRequest(method, "/v1/folder-labels", bytes.NewBufferString(body))
		r.RemoteAddr = testPhone
		r.Host = "127.0.0.1:22776"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set(deviceTokenHeader, token)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w.Code
	}
	put := func(token, dir string) int {
		b, _ := json.Marshal(map[string]string{"dir": dir, "label": "work"})
		return do(http.MethodPut, token, string(b))
	}
	if got := put(controller.Token, inside); got != 200 {
		t.Errorf("controller, a folder under home: %d", got)
	}
	if got := put(controller.Token, outside); got != 403 {
		t.Errorf("controller, a folder outside home: %d", got)
	}
	if got := put(viewer.Token, inside); got != 403 {
		t.Errorf("viewer: %d", got)
	}
	if got := do(http.MethodGet, viewer.Token, ""); got != 200 {
		t.Errorf("viewer reads the labels: %d", got)
	}
}
