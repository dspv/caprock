package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

// The page names the daemon that served it, so a page left open across a
// daemon upgrade can tell it is the old UI (ui/src/lib/staleui.ts).
func TestThePageNamesTheDaemonThatServedIt(t *testing.T) {
	ui := fstest.MapFS{
		"index.html":    {Data: []byte("<html><head><title>x</title></head><body></body></html>")},
		"assets/app.js": {Data: []byte("js")},
	}
	s := &Server{d: Deps{UI: ui, Version: `0.78.2-dev+abc"<`}}
	h := s.uiHandler()
	for _, p := range []string{"/", "/index.html", "/some/route"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		body := rec.Body.String()
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", p, rec.Code)
		}
		want := `<meta name="caprock-version" content="0.78.2-dev+abc&#34;&lt;" /></head>`
		if !strings.Contains(body, want) {
			t.Fatalf("%s: no escaped version meta before </head>:\n%s", p, body)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s: Cache-Control %q, want no-cache", p, got)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/app.js", nil))
	if rec.Body.String() != "js" {
		t.Fatalf("an asset is served as it is, got %q", rec.Body.String())
	}
}

func TestWithVersionLeavesAPageItCannotPlaceTheMetaIn(t *testing.T) {
	page := []byte("<p>no head</p>")
	if got := string(withVersion(page, "1.0.0")); got != string(page) {
		t.Fatalf("changed a page with no </head>: %q", got)
	}
	if got := string(withVersion([]byte("<head></head>"), "")); got != "<head></head>" {
		t.Fatalf("wrote an empty version: %q", got)
	}
}
