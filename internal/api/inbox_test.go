package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/store"
)

// A tiny PNG: the signature is all a thumbnail test needs.
var pngBytes = []byte("\x89PNG\r\n\x1a\nnot-really-a-picture")

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// inboxServer is a daemon with a data directory and a live bus.
func inboxServer(t *testing.T) (*Server, *env, string, *bus.Bus) {
	t.Helper()
	e := newEnv(t)
	dir := t.TempDir()
	b := bus.New()
	s := New(Deps{Store: e.st, Bus: b, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, DataDir: dir})
	return s, e, dir, b
}

func inboxDo(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rd = bytes.NewReader(raw)
	} else {
		rd = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rd)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestInboxSavesListsServesAndDeletes(t *testing.T) {
	s, e, dir, b := inboxServer(t)
	ctx := context.Background()
	p, _, err := store.InsertProject(ctx, e.st.DB(), store.Project{Root: "/work/alpha", Name: "alpha", Kind: "repo", Source: "folder", AddedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	sub := b.Subscribe(8)
	defer sub.Unsubscribe()

	// Text alone, to the Inbox.
	rr := inboxDo(t, s, "POST", "/v1/inbox", map[string]any{"text": "  an idea for later  "})
	if rr.Code != 200 {
		t.Fatalf("save text: %d %s", rr.Code, rr.Body)
	}
	// Text and a photo, to a project.
	rr = inboxDo(t, s, "POST", "/v1/inbox", map[string]any{
		"text": "look at this", "project_id": p.ID,
		"files": []map[string]string{{"name": "IMG_2041.png", "type": "image/png", "data": b64(pngBytes)}},
	})
	if rr.Code != 200 {
		t.Fatalf("save photo: %d %s", rr.Code, rr.Body)
	}
	var got struct{ Item store.InboxItem }
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	it := got.Item
	if it.ProjectName != "alpha" || it.ProjectRoot != "/work/alpha" || len(it.Files) != 1 || it.FromDevice != "" {
		t.Fatalf("stored %+v", it)
	}
	photo := it.Files[0]
	if !strings.HasPrefix(photo, config.InboxDir(dir)+string(filepath.Separator)) || filepath.Base(photo) != "IMG_2041.png" {
		t.Fatalf("photo written to %s, want under %s", photo, config.InboxDir(dir))
	}

	// The live socket hears both saves.
	for i := 0; i < 2; i++ {
		select {
		case f := <-sub.C:
			if f.Type != bus.FrameInbox {
				t.Fatalf("frame %d is %q", i, f.Type)
			}
		case <-time.After(time.Second):
			t.Fatalf("no inbox frame %d", i)
		}
	}

	rr = inboxDo(t, s, "GET", "/v1/inbox", nil)
	var list struct {
		Items []store.InboxItem `json:"items"`
		Max   int               `json:"max"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 2 || list.Max != inboxMax || list.Items[0].ID != it.ID || list.Items[1].Text != "an idea for later" {
		t.Fatalf("list %+v", list)
	}
	if list.Items[1].Files == nil {
		t.Fatal("files must be [] rather than null for an item without any")
	}

	// The thumbnail.
	rr = inboxDo(t, s, "GET", "/v1/inbox/"+jsonInt(it.ID)+"/files/0", nil)
	if rr.Code != 200 || rr.Header().Get("Content-Type") != "image/png" || !bytes.Equal(rr.Body.Bytes(), pngBytes) {
		t.Fatalf("thumbnail: %d %q", rr.Code, rr.Header().Get("Content-Type"))
	}
	if rr := inboxDo(t, s, "GET", "/v1/inbox/"+jsonInt(it.ID)+"/files/1", nil); rr.Code != 404 {
		t.Fatalf("a file past the end: %d", rr.Code)
	}

	// Delete takes the photo with it.
	if rr := inboxDo(t, s, "DELETE", "/v1/inbox/"+jsonInt(it.ID), nil); rr.Code != 204 {
		t.Fatalf("delete: %d %s", rr.Code, rr.Body)
	}
	if _, err := os.Stat(filepath.Dir(photo)); !os.IsNotExist(err) {
		t.Fatalf("the photo's directory outlived its item: %v", err)
	}
	if rr := inboxDo(t, s, "DELETE", "/v1/inbox/"+jsonInt(it.ID), nil); rr.Code != 404 {
		t.Fatalf("delete twice: %d", rr.Code)
	}
}

func TestInboxRefusesWhatItCannotKeep(t *testing.T) {
	s, _, dir, _ := inboxServer(t)
	for _, tc := range []struct {
		name string
		body any
		want int
	}{
		{"nothing", map[string]any{"text": "   "}, 400},
		{"a NUL", map[string]any{"text": "a\x00b"}, 400},
		{"too long", map[string]any{"text": strings.Repeat("x", inboxTextBytes+1)}, 400},
		{"no such project", map[string]any{"text": "x", "project_id": 99}, 400},
		{"too many files", map[string]any{"files": []map[string]string{
			{"name": "a.png", "data": b64(pngBytes)}, {"name": "b.png", "data": b64(pngBytes)},
			{"name": "c.png", "data": b64(pngBytes)}, {"name": "d.png", "data": b64(pngBytes)},
			{"name": "e.png", "data": b64(pngBytes)},
		}}, 400},
		{"a program", map[string]any{"files": []map[string]string{{"name": "setup.exe", "data": b64([]byte("MZ"))}}}, 415},
		{"bad base64", map[string]any{"files": []map[string]string{{"name": "a.png", "data": "!!"}}}, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if rr := inboxDo(t, s, "POST", "/v1/inbox", tc.body); rr.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", rr.Code, tc.want, rr.Body)
			}
		})
	}
	// A refused item leaves no file behind, even when an earlier one of its
	// files had been written.
	rr := inboxDo(t, s, "POST", "/v1/inbox", map[string]any{"files": []map[string]string{
		{"name": "ok.png", "data": b64(pngBytes)}, {"name": "run.bat", "data": b64([]byte("x"))},
	}})
	if rr.Code != 415 {
		t.Fatalf("a good file then a refused one: %d", rr.Code)
	}
	if entries, _ := os.ReadDir(config.InboxDir(dir)); len(entries) != 0 {
		t.Fatalf("a refused item left %d directories behind", len(entries))
	}
}

// A saved file other than an image is the session's to read by path; served
// from this origin, an HTML file would run as the dashboard.
func TestInboxServesOnlyImages(t *testing.T) {
	s, _, _, _ := inboxServer(t)
	rr := inboxDo(t, s, "POST", "/v1/inbox", map[string]any{"files": []map[string]string{
		{"name": "page.html", "data": b64([]byte("<script>alert(1)</script>"))},
	}})
	if rr.Code != 200 {
		t.Fatalf("save: %d %s", rr.Code, rr.Body)
	}
	var got struct{ Item store.InboxItem }
	_ = json.NewDecoder(rr.Body).Decode(&got)
	if rr := inboxDo(t, s, "GET", "/v1/inbox/"+jsonInt(got.Item.ID)+"/files/0", nil); rr.Code != 404 {
		t.Fatalf("an HTML file was served: %d", rr.Code)
	}
}

// A path in the files column that is not the Inbox's own is never read or
// deleted, whatever put it there.
func TestInboxTouchesOnlyItsOwnFiles(t *testing.T) {
	s, e, dir, _ := inboxServer(t)
	outside := filepath.Join(t.TempDir(), "keep.png")
	if err := os.WriteFile(outside, pngBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	it, err := store.InsertInboxItem(context.Background(), e.st.DB(), store.InboxItem{Files: []string{outside, filepath.Join(config.InboxDir(dir), "x.png")}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if rr := inboxDo(t, s, "GET", "/v1/inbox/"+jsonInt(it.ID)+"/files/0", nil); rr.Code != 404 {
		t.Fatalf("a file outside the Inbox was served: %d", rr.Code)
	}
	if rr := inboxDo(t, s, "DELETE", "/v1/inbox/"+jsonInt(it.ID), nil); rr.Code != 204 {
		t.Fatalf("delete: %d", rr.Code)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("deleting the item removed a file outside the Inbox: %v", err)
	}
}

// A controller phone saves, and the item says which phone; a viewer cannot.
func TestAControllerPhoneSavesToTheInbox(t *testing.T) {
	e := newEnv(t)
	s, _, viewer, controller := pairedPhones(t, Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, DataDir: t.TempDir()})
	post := func(tok string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/v1/inbox", strings.NewReader(`{"text":"from the bus"}`))
		req.RemoteAddr = testPhone
		req.Host = strings.TrimPrefix(testLANURL, "http://")
		req.Header.Set("Origin", testLANURL)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(deviceTokenHeader, tok)
		rr := httptest.NewRecorder()
		s.ServeHTTP(rr, req)
		return rr
	}
	if rr := post(viewer.Token); rr.Code != http.StatusForbidden {
		t.Fatalf("a viewer saved: %d", rr.Code)
	}
	rr := post(controller.Token)
	if rr.Code != 200 {
		t.Fatalf("the controller could not save: %d %s", rr.Code, rr.Body)
	}
	var got struct{ Item store.InboxItem }
	_ = json.NewDecoder(rr.Body).Decode(&got)
	if got.Item.FromDevice != "controller phone" {
		t.Fatalf("from_device = %q", got.Item.FromDevice)
	}
}
