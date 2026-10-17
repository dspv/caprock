package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/dspv/caprock/internal/browser"
)

// BrowserController finds the web browsers installed here and opens a link in
// one (internal/browser): the chooser a ⇧⌘-click on a terminal link opens.
// nil ⇒ the endpoints answer 501.
type BrowserController interface {
	// List is the installed browsers, the default first.
	List() []browser.Browser
	// Open opens url (http or https) in the browser with this id.
	Open(ctx context.Context, id, url string) (browser.Browser, error)
}

// errBrowserNotLocal is the refusal for any request not made on this machine.
var errBrowserNotLocal = errors.New("a browser opens on the screen of the machine Caprock runs on, so only that machine may ask")

// handleBrowsers lists the browsers installed here. Local only, like opening
// one: a phone has its own browser and no use for this machine's.
func (s *Server) handleBrowsers(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errBrowserNotLocal)
		return
	}
	if s.d.Browsers == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("choosing a browser is not available"))
		return
	}
	bs := s.d.Browsers.List()
	if bs == nil {
		bs = []browser.Browser{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"browsers": bs})
}

// handleOpenBrowser opens an http(s) link in the browser the user picked. It
// is refused for anything but a request from this machine — never a paired
// phone, never a tunnel — whatever the device's role: it acts on the screen
// of this machine. The device allowlists in lanauth.go do not name it either.
func (s *Server) handleOpenBrowser(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errBrowserNotLocal)
		return
	}
	if s.d.Browsers == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("choosing a browser is not available"))
		return
	}
	var body struct {
		Browser string `json:"browser"`
		URL     string `json:"url"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&body); err != nil || body.Browser == "" {
		s.failCode(w, http.StatusBadRequest, errors.New("bad request: want {browser, url}"))
		return
	}
	b, err := s.d.Browsers.Open(r.Context(), body.Browser, body.URL)
	if err != nil {
		code := http.StatusBadGateway
		if errors.Is(err, browser.ErrBadURL) || errors.Is(err, browser.ErrNoBrowser) {
			code = http.StatusBadRequest
		}
		s.failCode(w, code, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"browser": b})
}
