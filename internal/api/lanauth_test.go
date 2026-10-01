package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/pairing"
)

// A request that did not come from this machine sees nothing until it proves
// which device it is. This is the whole security model of LAN access, so it is
// asserted directly rather than through the HTTP stack: `from` is the kernel's
// view of the peer, which a caller cannot forge.
func TestADeviceOnTheNetworkSeesNothingUntilItPairs(t *testing.T) {
	ps := pairing.New()
	s := New(Deps{Pairing: ps})

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
	s := New(Deps{Pairing: ps})
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
	s := New(Deps{}) // no pairing store: LAN access was never turned on

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

// pairedTablet is a daemon with LAN access on and one paired device.
func pairedTablet(t *testing.T, d Deps) (*Server, string) {
	t.Helper()
	ps := pairing.New()
	d.Pairing = ps
	s := New(d)
	code, err := ps.NewCode()
	if err != nil {
		t.Fatal(err)
	}
	dev, err := ps.Redeem(code, "tablet")
	if err != nil {
		t.Fatal(err)
	}
	return s, dev.Token
}

// ADR-029: a tablet is somewhere to read figures, not a second control room.
// The token used to be the whole check, so a paired phone could start a
// command, type into a session, kill it, or rewrite the settings. It may read;
// everything else is 403 — and the same requests from the machine itself are
// untouched.
func TestAPairedDeviceReadsButDoesNotControl(t *testing.T) {
	s, tok := pairedTablet(t, Deps{})

	for _, tc := range []struct {
		method, path string
		want         int // 0 = served
	}{
		// Reads.
		{http.MethodGet, "/v1/sessions", 0},
		{http.MethodGet, "/v1/sessions/abc", 0},
		{http.MethodHead, "/v1/sessions", 0},
		{http.MethodGet, "/v1/stats/summary", 0},
		{http.MethodGet, "/v1/notes", 0},
		{http.MethodGet, "/v1/tasks", 0},
		{http.MethodGet, "/v1/live", 0},
		{http.MethodGet, "/assets/index.js", 0},
		// Control.
		{http.MethodPost, "/v1/agents", http.StatusForbidden},
		{http.MethodPost, "/v1/agents/abc/input", http.StatusForbidden},
		{http.MethodPost, "/v1/agents/abc/signal", http.StatusForbidden},
		{http.MethodPut, "/v1/settings", http.StatusForbidden},
		{http.MethodPost, "/v1/tasks", http.StatusForbidden},
		{http.MethodPost, "/v1/tasks/abc/approve", http.StatusForbidden},
		{http.MethodPost, "/v1/orchestrator/start", http.StatusForbidden},
		{http.MethodPost, "/v1/hive", http.StatusForbidden},
		{http.MethodPost, "/v1/pair/code", http.StatusForbidden},
		{http.MethodDelete, "/v1/pair/devices/all", http.StatusForbidden},
		{http.MethodPost, "/v1/pair/lan", http.StatusForbidden},
		{http.MethodPost, "/v1/shutdown", http.StatusForbidden},
		{http.MethodPost, "/v1/paste", http.StatusForbidden},
		// GETs that are not reads: the terminal socket types into the
		// session, and the directory listings exist to start one.
		{http.MethodGet, "/v1/agents/abc/term", http.StatusForbidden},
		{http.MethodGet, "/v1/browse", http.StatusForbidden},
		{http.MethodGet, "/v1/recent-dirs", http.StatusForbidden},
		// Closed by default: a route nobody has named.
		{http.MethodGet, "/v1/something-added-next-week", http.StatusForbidden},
		{http.MethodOptions, "/v1/sessions", http.StatusForbidden},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, nil)
			r.RemoteAddr = "192.168.1.50:51000"
			r.Header.Set(deviceTokenHeader, tok)
			if got, reason := s.gate(r); got != tc.want {
				t.Fatalf("paired device: status = %d, want %d (%s)", got, tc.want, reason)
			}

			// The same request from the machine itself is not the gate's
			// business.
			local := httptest.NewRequest(tc.method, tc.path, nil)
			local.RemoteAddr = "127.0.0.1:51000"
			if got, reason := s.gate(local); got != 0 {
				t.Fatalf("loopback: status = %d (%s)", got, reason)
			}
		})
	}
}

// The refusal reaches the caller as 403 with a reason, through the real
// handler chain, and never reaches the handler.
func TestAPairedDeviceIsRefusedWithA403(t *testing.T) {
	s, tok := pairedTablet(t, Deps{})
	r := httptest.NewRequest(http.MethodPost, "/v1/agents", strings.NewReader(`{"cwd":"/tmp"}`))
	r.RemoteAddr = "192.168.1.50:51000"
	r.Header.Set(deviceTokenHeader, tok)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", w.Code, w.Body)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body["error"] == "" {
		t.Fatalf("want a JSON error naming why, got %q (%v)", w.Body, err)
	}
}

// The licence key is what pays for the product; a device allowed to read the
// figures does not get to copy it. The machine itself still sees it, or the
// licence field could not show what is entered.
func TestAPairedDeviceDoesNotSeeTheLicenceKey(t *testing.T) {
	fs := &fakeSettings{cur: Settings{LicenseKey: "CAPROCK-SECRET", PlanKind: "flat"}}
	s, tok := pairedTablet(t, Deps{Settings: fs})

	get := func(from, token string) Settings {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/v1/settings", nil)
		r.RemoteAddr = from
		if token != "" {
			r.Header.Set(deviceTokenHeader, token)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("GET /v1/settings from %s: %d %s", from, w.Code, w.Body)
		}
		var st Settings
		if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil {
			t.Fatal(err)
		}
		return st
	}
	if st := get("192.168.1.50:51000", tok); st.LicenseKey != "" || st.PlanKind != "flat" {
		t.Fatalf("paired device got licence %q, plan %q", st.LicenseKey, st.PlanKind)
	}
	if st := get("127.0.0.1:51000", ""); st.LicenseKey != "CAPROCK-SECRET" {
		t.Fatalf("loopback lost the licence key: %q", st.LicenseKey)
	}
}
