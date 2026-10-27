package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// cardSite stands in for caprock.dev/api/card. Tests never reach the real
// site: CAPROCK_SHARE_URL points here.
type cardSite struct {
	mu       sync.Mutex
	srv      *httptest.Server
	uploads  [][]byte
	types    []string
	deletes  []string // "<id> <token>"
	upStatus int      // 0: 201 with an answer
	delCode  int      // 0: 204
	answer   func(base string) string
}

func newCardSite(t *testing.T) *cardSite {
	t.Helper()
	c := &cardSite{}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/card":
			raw, _ := io.ReadAll(r.Body)
			c.uploads = append(c.uploads, raw)
			c.types = append(c.types, r.Header.Get("Content-Type"))
			if c.upStatus != 0 {
				w.WriteHeader(c.upStatus)
				return
			}
			w.WriteHeader(http.StatusCreated)
			if c.answer != nil {
				_, _ = io.WriteString(w, c.answer(c.srv.URL))
				return
			}
			_, _ = io.WriteString(w, `{"id":"abc123","url":"`+c.srv.URL+`/c/abc123","image":"`+c.srv.URL+`/c/abc123.png","delete_token":"tok-1"}`)
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/card/"):
			c.deletes = append(c.deletes, strings.TrimPrefix(r.URL.Path, "/api/card/")+" "+r.Header.Get("X-Delete-Token"))
			if c.delCode != 0 {
				w.WriteHeader(c.delCode)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(c.srv.Close)
	t.Setenv("CAPROCK_SHARE_URL", c.srv.URL)
	return c
}

func shareServer(t *testing.T) (*Server, *store.Store, string, string) {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	s, _, v, c := pairedPhones(t, Deps{Store: st})
	return s, st, v.Token, c.Token
}

var cardPNG = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{7}, 64)...)

// The exact PNG goes up as the body, the link comes back, the delete token
// stays on the machine and is never in a response.
func TestShareCardUploadsTheExactPictureAndKeepsTheToken(t *testing.T) {
	site := newCardSite(t)
	s, st, _, _ := shareServer(t)

	w := call(t, s, machine, "", "POST", "/v1/share/card", `{"png":"`+b64(cardPNG)+`","text":"secret words"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "tok-1") || strings.Contains(w.Body.String(), "delete_token") {
		t.Fatalf("the delete token left the daemon: %s", w.Body.String())
	}
	var got SharedCardView
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if got.ID != "abc123" || got.URL != site.srv.URL+"/c/abc123" || got.Bytes != int64(len(cardPNG)) {
		t.Fatalf("answer: %+v", got)
	}
	if len(site.uploads) != 1 || !bytes.Equal(site.uploads[0], cardPNG) || site.types[0] != "image/png" {
		t.Fatalf("site got %d uploads, type %v", len(site.uploads), site.types)
	}
	row, ok, _ := store.GetSharedCard(context.Background(), st.DB(), "abc123")
	if !ok || row.DeleteToken != "tok-1" {
		t.Fatalf("row: %+v %v", row, ok)
	}

	// Listed without the token.
	w = call(t, s, machine, "", "GET", "/v1/share/cards", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"id":"abc123"`) || strings.Contains(w.Body.String(), "tok-1") {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}

	// Removed: the site is asked with the token, then the row goes.
	w = call(t, s, machine, "", "DELETE", "/v1/share/cards/abc123", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"removed":true`) {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	if len(site.deletes) != 1 || site.deletes[0] != "abc123 tok-1" {
		t.Fatalf("site deletes: %v", site.deletes)
	}
	if _, ok, _ := store.GetSharedCard(context.Background(), st.DB(), "abc123"); ok {
		t.Fatal("row kept after delete")
	}
	if w := call(t, s, machine, "", "DELETE", "/v1/share/cards/abc123", ""); w.Code != http.StatusNotFound {
		t.Fatalf("second delete: %d", w.Code)
	}
}

// The site's refusals reach the sheet as their own status, so it can say
// why before it falls back to the clipboard; nothing is kept.
func TestShareCardPassesTheSitesRefusalsOn(t *testing.T) {
	for _, tc := range []struct{ site, want int }{
		{http.StatusTooManyRequests, http.StatusTooManyRequests},
		{http.StatusRequestEntityTooLarge, http.StatusRequestEntityTooLarge},
		{http.StatusUnsupportedMediaType, http.StatusUnsupportedMediaType},
		{http.StatusInternalServerError, http.StatusBadGateway},
	} {
		site := newCardSite(t)
		site.upStatus = tc.site
		s, st, _, _ := shareServer(t)
		w := call(t, s, machine, "", "POST", "/v1/share/card", `{"png":"`+b64(cardPNG)+`"}`)
		if w.Code != tc.want || strings.Contains(w.Body.String(), site.srv.URL) {
			t.Errorf("site %d: %d %s", tc.site, w.Code, w.Body.String())
		}
		if cards, _ := store.SharedCards(context.Background(), st.DB()); len(cards) != 0 {
			t.Errorf("site %d: kept %d rows", tc.site, len(cards))
		}
	}
}

// What the daemon refuses never reaches the site.
func TestShareCardRefusesBeforeUploading(t *testing.T) {
	site := newCardSite(t)
	s, _, viewer, controller := shareServer(t)
	big := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, shareCardMax)...)
	for name, tc := range map[string]struct {
		body string
		want int
	}{
		"not a png": {`{"png":"` + b64([]byte("GIF89a....")) + `"}`, http.StatusBadRequest},
		"not json":  {`png`, http.StatusBadRequest},
		"empty":     {`{}`, http.StatusBadRequest},
		"too big":   {`{"png":"` + b64(big) + `"}`, http.StatusRequestEntityTooLarge},
	} {
		if w := call(t, s, machine, "", "POST", "/v1/share/card", tc.body); w.Code != tc.want {
			t.Errorf("%s: %d, want %d (%s)", name, w.Code, tc.want, w.Body.String())
		}
	}
	// Machine-only: a paired phone shares through its own share sheet.
	for _, tok := range []string{viewer, controller} {
		if w := call(t, s, "192.168.1.20:5000", tok, "POST", "/v1/share/card", `{"png":"`+b64(cardPNG)+`"}`); w.Code != http.StatusForbidden {
			t.Errorf("paired device: %d", w.Code)
		}
	}
	if len(site.uploads) != 0 {
		t.Fatalf("site got %d uploads", len(site.uploads))
	}
}

// An answer that would put another site's link in the post is refused, and
// a picture whose token could not be kept is taken down at once.
func TestShareCardChecksTheAnswer(t *testing.T) {
	site := newCardSite(t)
	site.answer = func(string) string {
		return `{"id":"x1","url":"https://elsewhere.example/c/x1","delete_token":"t"}`
	}
	s, st, _, _ := shareServer(t)
	if w := call(t, s, machine, "", "POST", "/v1/share/card", `{"png":"`+b64(cardPNG)+`"}`); w.Code != http.StatusBadGateway {
		t.Fatalf("foreign link: %d %s", w.Code, w.Body.String())
	}
	site.answer = func(base string) string { return `{"id":"../x","url":"` + base + `/c/x","delete_token":"t"}` }
	if w := call(t, s, machine, "", "POST", "/v1/share/card", `{"png":"`+b64(cardPNG)+`"}`); w.Code != http.StatusBadGateway {
		t.Fatalf("bad id: %d %s", w.Code, w.Body.String())
	}
	if cards, _ := store.SharedCards(context.Background(), st.DB()); len(cards) != 0 {
		t.Fatalf("kept %d rows", len(cards))
	}
}

// The site no longer has it: forgotten here too. The site failing: kept, to
// try again.
func TestDeleteSharedCardKeepsTheRowWhenTheSiteFails(t *testing.T) {
	site := newCardSite(t)
	s, st, _, _ := shareServer(t)
	ctx := context.Background()
	_ = store.RecordSharedCard(ctx, st.DB(), store.SharedCard{ID: "k1", URL: site.srv.URL + "/c/k1", DeleteToken: "t1", At: 1})
	_ = store.RecordSharedCard(ctx, st.DB(), store.SharedCard{ID: "k2", URL: site.srv.URL + "/c/k2", DeleteToken: "t2", At: 2})

	site.delCode = http.StatusInternalServerError
	if w := call(t, s, machine, "", "DELETE", "/v1/share/cards/k1", ""); w.Code != http.StatusBadGateway {
		t.Fatalf("site failing: %d", w.Code)
	}
	if _, ok, _ := store.GetSharedCard(ctx, st.DB(), "k1"); !ok {
		t.Fatal("row dropped while the picture is still up")
	}
	site.delCode = http.StatusNotFound
	w := call(t, s, machine, "", "DELETE", "/v1/share/cards/k2", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"already_gone":true`) {
		t.Fatalf("already gone: %d %s", w.Code, w.Body.String())
	}
	if _, ok, _ := store.GetSharedCard(ctx, st.DB(), "k2"); ok {
		t.Fatal("row kept for a picture the site no longer has")
	}
}
