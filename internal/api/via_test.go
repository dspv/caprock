package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/pairing"
)

// How a request reached the machine, from the peer address and the relay's
// own mark — and never the relay's mark on a request that did not come over
// loopback, where anyone could write it.
func TestTransportOf(t *testing.T) {
	for _, tc := range []struct {
		name, from, via, want string
	}{
		{"the home Wi-Fi", "10.100.102.40:51000", "", pairing.ViaLAN},
		{"another private range", "192.168.1.50:51000", "", pairing.ViaLAN},
		{"Tailscale", "100.101.102.103:51000", "", pairing.ViaTailscale},
		{"the relay channel", "127.0.0.1:51000", "1.1 caprock-remote", pairing.ViaRelay},
		{"a tunnel of the owner's own", "127.0.0.1:51000", "1.1 Caddy", ""},
		{"the machine itself", "127.0.0.1:51000", "", ""},
		{"a LAN request claiming the relay's mark", "10.100.102.40:51000", "1.1 caprock-remote", pairing.ViaLAN},
	} {
		r := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
		r.RemoteAddr = tc.from
		if tc.via != "" {
			r.Header.Set("Via", tc.via)
		}
		if got := transportOf(r); got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
}

// The owner's phone, 2026-10-14: paired on the Wi-Fi address, then dead on
// mobile data with nothing saying why. The gate records how each device last
// arrived, and keeps it in devices.json, so Settings can say "Wi-Fi link".
func TestTheGateRecordsHowADeviceArrived(t *testing.T) {
	dir := t.TempDir()
	s, ps, viewer, _ := pairedPhones(t, Deps{DataDir: dir})
	saved := func() string {
		t.Helper()
		ds, err := config.ReadDevices(dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range ds {
			if d.ID == viewer.ID {
				return d.Via
			}
		}
		return "(none)"
	}
	listed := func() string {
		for _, d := range ps.Devices() {
			if d.ID == viewer.ID {
				return d.Via
			}
		}
		return "(none)"
	}

	if got, why := s.gate(phoneRequest("GET /v1/sessions", viewer.Token)); got != 0 {
		t.Fatalf("over the Wi-Fi: %d (%s)", got, why)
	}
	if listed() != pairing.ViaLAN || saved() != pairing.ViaLAN {
		t.Fatalf("after a Wi-Fi request: listed %q, saved %q", listed(), saved())
	}

	if got, why := s.gate(relayedRequest("GET /v1/sessions", viewer.Token, "Via", "1.1 caprock-remote")); got != 0 {
		t.Fatalf("through the relay: %d (%s)", got, why)
	}
	if listed() != pairing.ViaRelay || saved() != pairing.ViaRelay {
		t.Fatalf("after a relayed request: listed %q, saved %q", listed(), saved())
	}

	// A route that cannot be told apart keeps what was known.
	if got, _ := s.gate(relayedRequest("GET /v1/sessions", viewer.Token, "X-Forwarded-For", "203.0.113.9")); got != 0 {
		t.Fatalf("through a tunnel: %d", got)
	}
	if listed() != pairing.ViaRelay {
		t.Fatalf("a tunnel overwrote the route: %q", listed())
	}
}

// Pairing records the route it was made by, before the device's next request.
func TestPairingRecordsTheRouteItCameBy(t *testing.T) {
	ps := pairing.New()
	s := New(Deps{Pairing: ps, LANURL: testLANURL, DataDir: t.TempDir()})
	code, err := ps.NewCode()
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/v1/pair", strings.NewReader(`{"code":"`+code+`","name":"Android phone"}`))
	r.RemoteAddr, r.Host = testPhone, "192.168.1.10:4173"
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("pair: %d %s", w.Code, w.Body)
	}
	ds := ps.Devices()
	if len(ds) != 1 || ds[0].Via != pairing.ViaLAN {
		t.Fatalf("devices after pairing on the Wi-Fi: %+v", ds)
	}
}

type fakeRemote struct{ on bool }

func (f *fakeRemote) RemoteState(string) RemoteState {
	return RemoteState{Enabled: f.on, Status: "online", App: "https://m.caprock.dev"}
}
func (f *fakeRemote) SetRemote(on bool, _, _ string) error {
	f.on = on
	return nil
}

// A phone's page learns from GET /v1/pair/me whether it came over the Wi-Fi
// link, and whether access from anywhere is on.
func TestPairMeSaysTheRouteAndWhetherAnywhereIsOn(t *testing.T) {
	rem := &fakeRemote{on: true}
	s, _, viewer, _ := pairedPhones(t, Deps{Remote: rem})
	ask := func(r *http.Request) pairMe {
		t.Helper()
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		var me pairMe
		if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil || w.Code != http.StatusOK {
			t.Fatalf("pair/me: %d %s", w.Code, w.Body)
		}
		return me
	}
	onWiFi := func() *http.Request {
		r := phoneRequest("GET /v1/pair/me", viewer.Token)
		r.Host = "192.168.1.10:4173"
		return r
	}
	if me := ask(onWiFi()); me.Via != pairing.ViaLAN || !me.Anywhere || me.App != "https://m.caprock.dev" {
		t.Errorf("over the Wi-Fi with anywhere on: %+v", me)
	}
	if me := ask(relayedRequest("GET /v1/pair/me", viewer.Token, "Via", "1.1 caprock-remote")); me.Via != pairing.ViaRelay {
		t.Errorf("through the relay: %+v", me)
	}
	rem.on = false
	if me := ask(onWiFi()); me.Via != pairing.ViaLAN || me.Anywhere || me.App != "" {
		t.Errorf("over the Wi-Fi with anywhere off: %+v", me)
	}
	local := httptest.NewRequest(http.MethodGet, "/v1/pair/me", nil)
	local.RemoteAddr, local.Host = "127.0.0.1:51000", "127.0.0.1:22776"
	if me := ask(local); me.Role != "owner" || me.Via != "" {
		t.Errorf("on the machine: %+v", me)
	}
}
