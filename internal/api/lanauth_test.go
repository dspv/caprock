package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dspv/caprock/internal/pairing"
)

// A request that did not come from this machine sees nothing until it proves
// which device it is. This is the whole security model of LAN access, so it is
// asserted directly rather than through the HTTP stack: `from` is the kernel's
// view of the peer, which a caller cannot forge.
func TestADeviceOnTheNetworkSeesNothingUntilItPairs(t *testing.T) {
	ps := pairing.New()
	s := &Server{d: Deps{Pairing: ps}}

	code, err := ps.NewCode()
	if err != nil {
		t.Fatal(err)
	}
	dev, err := ps.Redeem(code, "tablet")
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name  string
		from  string
		path  string
		token string
		want  bool
	}{
		{"loopback needs no token", "127.0.0.1:51000", "/v1/sessions", "", true},
		{"loopback IPv6 too", "[::1]:51000", "/v1/sessions", "", true},
		{"a stranger gets no sessions", "192.168.1.50:51000", "/v1/sessions", "", false},
		{"a stranger gets no costs", "192.168.1.50:51000", "/v1/stats/summary", "", false},
		{"a stranger gets no prose", "192.168.1.50:51000", "/v1/notes", "", false},
		{"a wrong token is no token", "192.168.1.50:51000", "/v1/sessions", "not-the-token", false},
		{"a paired device gets in", "192.168.1.50:51000", "/v1/sessions", dev.Token, true},
		// The two things that must work before pairing, or there is no way in.
		{"the pairing endpoint is open", "192.168.1.50:51000", "/v1/pair", "", true},
		{"the page itself is open", "192.168.1.50:51000", "/assets/index.js", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, tc.path, nil)
			r.RemoteAddr = tc.from
			if tc.token != "" {
				r.Header.Set(deviceTokenHeader, tc.token)
			}
			if got, reason := s.allowRequest(r); got != tc.want {
				t.Fatalf("allowed = %v, want %v (%s)", got, tc.want, reason)
			}
		})
	}
}

// Revoking a device has to take effect on the next request, not the next
// restart. Someone revokes a tablet because they lost it.
func TestARevokedDeviceIsOutImmediately(t *testing.T) {
	ps := pairing.New()
	s := &Server{d: Deps{Pairing: ps}}
	code, _ := ps.NewCode()
	dev, err := ps.Redeem(code, "lost tablet")
	if err != nil {
		t.Fatal(err)
	}

	r := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	r.RemoteAddr = "192.168.1.50:51000"
	r.Header.Set(deviceTokenHeader, dev.Token)
	if ok, _ := s.allowRequest(r); !ok {
		t.Fatal("a freshly paired device was refused")
	}

	if !ps.Revoke(dev.ID) {
		t.Fatal("revoke reported no such device")
	}
	if ok, _ := s.allowRequest(r); ok {
		t.Fatal("a revoked device was still served")
	}
}

// With LAN access off, the gate changes nothing at all.
//
// There is no second listener, so a non-loopback RemoteAddr cannot be a device
// on the network — it is a test's synthetic address, or loopback reached by a
// route the kernel labels differently. A gate that starts refusing requests
// when the feature it guards is switched *off* is one nobody can reason about,
// and it would have broken every existing caller.
func TestWithLanOffTheGateIsInert(t *testing.T) {
	s := &Server{d: Deps{}} // no pairing store: LAN access was never turned on

	for _, from := range []string{"127.0.0.1:51000", "192.0.2.1:1234", "192.168.1.50:51000"} {
		r := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
		r.RemoteAddr = from
		if ok, reason := s.allowRequest(r); !ok {
			t.Errorf("refused %s on a loopback-only daemon: %s", from, reason)
		}
	}
}

// A new endpoint must be private by default. The check is written so that
// adding a route changes nothing about who may reach it: everything under /v1
// is closed unless it is named.
func TestANewEndpointIsClosedUntilSomeoneOpensIt(t *testing.T) {
	if openToUnpairedDevices("/v1/something-added-next-week") {
		t.Fatal("an unnamed /v1 endpoint was open to unpaired devices")
	}
	if !openToUnpairedDevices("/v1/pair") {
		t.Fatal("the pairing endpoint must stay reachable, or there is no way in")
	}
}
