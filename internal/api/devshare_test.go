package api

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/devshare"
)

func localJSON(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr, r.Host = "127.0.0.1:51000", "127.0.0.1:22776"
	r.Header.Set("Content-Type", "application/json")
	return r
}

// ADR-087: a dev server is shared from the machine, never from a paired phone
// or through the relay, and only a local origin.
func TestDevShareFromTheMachineOnly(t *testing.T) {
	m := devshare.New(devshare.Options{Address: func() (net.IP, error) { return net.IPv4(127, 0, 0, 1), nil }, Forbid: func(p int) bool { return p == 22776 }})
	defer m.Close()
	s, _, viewer, controller := pairedPhones(t, Deps{Remote: &fakeRemote{on: true}, DevShare: m})

	w := httptest.NewRecorder()
	s.ServeHTTP(w, localJSON("POST", "/v1/devshare", `{"url":"http://localhost:5173/about"}`))
	if w.Code != http.StatusOK {
		t.Fatalf("start: %d %s", w.Code, w.Body)
	}
	var sh devshare.Share
	if err := json.Unmarshal(w.Body.Bytes(), &sh); err != nil || sh.ID == "" || !strings.Contains(sh.URL, devshare.OpenPrefix) || sh.Path != "/about" {
		t.Fatalf("share %+v %v", sh, err)
	}

	for name, tok := range map[string]string{"viewer": viewer.Token, "controller": controller.Token} {
		for _, rt := range []string{"GET /v1/devshare", "POST /v1/devshare", "DELETE /v1/devshare/" + sh.ID} {
			w := httptest.NewRecorder()
			s.ServeHTTP(w, phoneRequest(rt, tok))
			if w.Code != http.StatusForbidden {
				t.Errorf("%s from a %s phone: %d, want 403", rt, name, w.Code)
			}
		}
	}
	w = httptest.NewRecorder()
	s.ServeHTTP(w, relayedRequest("GET /v1/devshare", controller.Token, "Via", "1.1 caprock-remote"))
	if w.Code != http.StatusForbidden {
		t.Errorf("through the relay: %d, want 403", w.Code)
	}

	w = httptest.NewRecorder()
	s.ServeHTTP(w, localJSON("GET", "/v1/devshare", ""))
	var list devShareList
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list.Shares) != 1 || list.IdleSec != 1800 || list.Max != 3 {
		t.Fatalf("list %d %s", w.Code, w.Body)
	}

	for body, want := range map[string]int{
		`{"url":"http://192.168.1.5:3000"}`: http.StatusBadRequest,
		`{"url":"http://localhost:22776"}`:  http.StatusBadRequest,
		`not json`:                          http.StatusBadRequest,
	} {
		w = httptest.NewRecorder()
		s.ServeHTTP(w, localJSON("POST", "/v1/devshare", body))
		if w.Code != want {
			t.Errorf("%s: %d, want %d", body, w.Code, want)
		}
	}

	w = httptest.NewRecorder()
	s.ServeHTTP(w, localJSON("DELETE", "/v1/devshare/"+sh.ID, ""))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"stopped":true`) {
		t.Fatalf("stop: %d %s", w.Code, w.Body)
	}
	if len(m.List()) != 0 {
		t.Fatal("still shared")
	}
}

func TestDevShareMissingIs501(t *testing.T) {
	s := New(Deps{})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, localJSON("GET", "/v1/devshare", ""))
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("%d", w.Code)
	}
}
