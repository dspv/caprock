package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/editor"
	"github.com/dspv/caprock/internal/pairing"
)

type fakeEditors struct {
	opened []string
	fail   error
}

func (f *fakeEditors) List() ([]editor.Editor, string) {
	return []editor.Editor{{ID: "zed", Name: "Zed"}, {ID: "vscode", Name: "VS Code"}}, "zed"
}

func (f *fakeEditors) Open(_ context.Context, id, path string, line int) (editor.Editor, error) {
	if f.fail != nil {
		return editor.Editor{}, f.fail
	}
	f.opened = append(f.opened, id+"|"+path)
	return editor.Editor{ID: "zed", Name: "Zed"}, nil
}

func localReq(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:51000"
	r.Host = "127.0.0.1:22776"
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestEditorsEndpoints(t *testing.T) {
	fe := &fakeEditors{}
	s := New(Deps{Version: "t", Editors: fe, Settings: &fakeSettings{}})
	serve := func(r *http.Request) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	w := serve(localReq("GET", "/v1/editors", ""))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"preferred":"zed"`) || !strings.Contains(w.Body.String(), `"name":"VS Code"`) {
		t.Fatalf("list: %d %s", w.Code, w.Body)
	}
	w = serve(localReq("POST", "/v1/editors/open", `{"path":"/Users/me/dev/app","editor":"vscode"}`))
	if w.Code != 200 || len(fe.opened) != 1 || fe.opened[0] != "vscode|/Users/me/dev/app" {
		t.Fatalf("open: %d %s %v", w.Code, w.Body, fe.opened)
	}
	w = serve(localReq("POST", "/v1/editors/open", `not json`))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad body: %d", w.Code)
	}
	fe.fail = editor.ErrBadPath
	if w = serve(localReq("POST", "/v1/editors/open", `{"path":"x"}`)); w.Code != http.StatusBadRequest {
		t.Fatalf("bad path: %d", w.Code)
	}

	// Anything not from this machine is refused before the controller is
	// asked: a tunnel on loopback, and a request from the network.
	fe.fail = nil
	tunnel := localReq("POST", "/v1/editors/open", `{"path":"/tmp"}`)
	tunnel.Header.Set("X-Forwarded-For", "203.0.113.9")
	remote := localReq("GET", "/v1/editors", "")
	remote.RemoteAddr = "192.168.1.50:51000"
	for _, r := range []*http.Request{tunnel, remote} {
		// 401 from the network gate, or 403 from the handler: refused either way.
		if w := serve(r); w.Code != http.StatusForbidden && w.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s from %s: %d, want a refusal", r.Method, r.URL.Path, r.RemoteAddr, w.Code)
		}
	}
	// The handler refuses on its own too, whatever the gate in front of it
	// decides in the future.
	for _, h := range []http.HandlerFunc{s.handleOpenEditor, s.handleEditors} {
		r := localReq("POST", "/v1/editors/open", `{"path":"/tmp"}`)
		r.RemoteAddr = "192.168.1.50:51000"
		w := httptest.NewRecorder()
		h(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("handler served a remote request: %d", w.Code)
		}
	}
	if len(fe.opened) != 1 {
		t.Fatalf("a refused request opened an editor: %v", fe.opened)
	}

	// The setting takes an editor this build knows, or nothing.
	if w := serve(localReq("PUT", "/v1/settings", `{"editor":"notepad; rm -rf ~"}`)); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown editor accepted: %d", w.Code)
	}
	if w := serve(localReq("PUT", "/v1/settings", `{"editor":"cursor"}`)); w.Code != 200 || !strings.Contains(w.Body.String(), `"editor":"cursor"`) {
		t.Fatalf("set: %d %s", w.Code, w.Body)
	}
}

func TestEditorsNotAvailable(t *testing.T) {
	s := New(Deps{Version: "t"})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, localReq("GET", "/v1/editors", ""))
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("no controller: %d", w.Code)
	}
}

// A paired phone — even one allowed to control sessions — never opens an
// editor on the Mac's screen.
func TestAPairedControllerCannotOpenAnEditor(t *testing.T) {
	fe := &fakeEditors{}
	ps := pairing.New()
	s := New(Deps{Version: "t", Editors: fe, Pairing: ps})
	code, err := ps.NewCode()
	if err != nil {
		t.Fatal(err)
	}
	dev, err := ps.Redeem(code, "phone")
	if err != nil {
		t.Fatal(err)
	}
	ps.SetRole(dev.ID, pairing.RoleController)
	for _, path := range []string{"/v1/editors/open", "/v1/editors"} {
		method := "POST"
		if path == "/v1/editors" {
			method = "GET"
		}
		r := httptest.NewRequest(method, path, strings.NewReader(`{"path":"/tmp"}`))
		r.RemoteAddr = "192.168.1.50:51000"
		r.Header.Set(deviceTokenHeader, dev.Token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("%s %s from a controller: %d, want 403", method, path, w.Code)
		}
	}
	if len(fe.opened) != 0 {
		t.Fatalf("opened: %v", fe.opened)
	}
}
