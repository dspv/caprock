package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/browser"
)

type fakeBrowsers struct{ opened []string }

func (f *fakeBrowsers) List() []browser.Browser {
	return []browser.Browser{{ID: "chrome", Name: "Google Chrome", Default: true}, {ID: "firefox", Name: "Firefox"}}
}

func (f *fakeBrowsers) Open(_ context.Context, id, u string) (browser.Browser, error) {
	if _, err := browser.CheckURL(u); err != nil {
		return browser.Browser{}, err
	}
	if id != "chrome" && id != "firefox" {
		return browser.Browser{}, fmt.Errorf("%w: %q", browser.ErrNoBrowser, id)
	}
	f.opened = append(f.opened, id+"|"+u)
	return browser.Browser{ID: id}, nil
}

func TestBrowsersEndpoints(t *testing.T) {
	fb := &fakeBrowsers{}
	s := New(Deps{Version: "t", Browsers: fb})
	serve := func(r *http.Request) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	w := serve(localReq("GET", "/v1/browsers", ""))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `{"id":"chrome","name":"Google Chrome","default":true}`) {
		t.Fatalf("list: %d %s", w.Code, w.Body)
	}
	w = serve(localReq("POST", "/v1/browsers/open", `{"browser":"firefox","url":"https://example.com/x"}`))
	if w.Code != 200 || len(fb.opened) != 1 || fb.opened[0] != "firefox|https://example.com/x" {
		t.Fatalf("open: %d %s %v", w.Code, w.Body, fb.opened)
	}
	for _, body := range []string{`not json`, `{"url":"https://example.com"}`, `{"browser":"firefox","url":"file:///etc/passwd"}`, `{"browser":"lynx","url":"https://example.com"}`} {
		if w := serve(localReq("POST", "/v1/browsers/open", body)); w.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d, want 400", body, w.Code)
		}
	}

	// Anything not from this machine is refused before the controller is asked.
	tunnel := localReq("POST", "/v1/browsers/open", `{"browser":"chrome","url":"https://example.com"}`)
	tunnel.Header.Set("X-Forwarded-For", "203.0.113.9")
	remote := localReq("GET", "/v1/browsers", "")
	remote.RemoteAddr = "192.168.1.50:51000"
	for _, r := range []*http.Request{tunnel, remote} {
		if w := serve(r); w.Code != http.StatusForbidden && w.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s from %s: %d, want a refusal", r.Method, r.URL.Path, r.RemoteAddr, w.Code)
		}
	}
	for _, h := range []http.HandlerFunc{s.handleOpenBrowser, s.handleBrowsers} {
		r := localReq("POST", "/v1/browsers/open", `{"browser":"chrome","url":"https://example.com"}`)
		r.RemoteAddr = "192.168.1.50:51000"
		w := httptest.NewRecorder()
		h(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("handler served a remote request: %d", w.Code)
		}
	}
	if len(fb.opened) != 1 {
		t.Fatalf("a refused request opened a browser: %v", fb.opened)
	}
}

func TestBrowsersNotAvailable(t *testing.T) {
	s := New(Deps{Version: "t"})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, localReq("GET", "/v1/browsers", ""))
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("no controller: %d", w.Code)
	}
}
