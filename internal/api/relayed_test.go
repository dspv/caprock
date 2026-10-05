package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The marks a proxy or tunnel on the machine leaves on what it relays onto
// loopback: cloudflared, ngrok, Caddy, nginx, `tailscale serve`.
var relayMarks = []struct{ name, value string }{
	{"Forwarded", "for=203.0.113.9;proto=https"},
	{"X-Forwarded-For", "203.0.113.9"},
	{"X-Forwarded-Host", "caprock.example.com"},
	{"X-Forwarded-Proto", "https"},
	{"X-Real-IP", "203.0.113.9"},
	{"CF-Connecting-IP", "203.0.113.9"},
	{"CF-Ray", "8a1b2c3d4e5f6a7b-AMS"},
	{"True-Client-IP", "203.0.113.9"},
	{"Tailscale-User-Login", "someone@example.com"},
	{"Tailscale-User-Name", "Someone"},
	{"Ngrok-Skip-Browser-Warning", "1"},
	{"X-Ngrok-Trace", "abc"},
	{"Via", "1.1 Caddy"},
}

// relayedRequest is a request for pattern that reached loopback through a
// relay: the kernel says 127.0.0.1, one header says otherwise.
func relayedRequest(pattern, token, mark, value string) *http.Request {
	r := phoneRequest(pattern, token)
	r.RemoteAddr = "127.0.0.1:51000"
	r.Host = "127.0.0.1:22776"
	r.Header.Set(mark, value)
	return r
}

// A tunnel on the Mac connects from 127.0.0.1 on behalf of a visitor from
// anywhere. Believing the kernel alone made that visitor the owner. Relayed,
// a request is a device like any other: no token is 401, and a token holds
// exactly its role — on the REST routes and on both WebSockets.
func TestARelayedRequestIsADeviceNotTheOwner(t *testing.T) {
	s, _, viewer, controller := pairedPhones(t, Deps{})
	cases := []struct {
		pattern                string
		none, asViewer, asCtrl int
	}{
		{"GET /v1/sessions", 401, 0, 0},
		{"GET /v1/live", 401, 0, 0},
		{"GET /v1/agents/{id}/term", 401, 403, 0},
		{"POST /v1/agents", 401, 403, 0},
		{"POST /v1/shutdown", 401, 403, 403},
		{"GET /v1/pair/state", 401, 403, 403},
	}
	for _, m := range relayMarks {
		t.Run(m.name, func(t *testing.T) {
			for _, tc := range cases {
				for _, who := range []struct {
					token string
					want  int
				}{{"", tc.none}, {viewer.Token, tc.asViewer}, {controller.Token, tc.asCtrl}} {
					if got, why := s.gate(relayedRequest(tc.pattern, who.token, m.name, m.value)); got != who.want {
						t.Errorf("%s, token %t: %d, want %d (%s)", tc.pattern, who.token != "", got, who.want, why)
					}
				}
			}
		})
	}
}

// With network access off there is no device a relayed request could be, so
// it is refused whatever it carries — while the dashboard's files, which hold
// no figures, still load.
func TestARelayedRequestWithNetworkAccessOffIsRefused(t *testing.T) {
	s := New(Deps{})
	for _, m := range relayMarks {
		for _, pattern := range []string{"GET /v1/sessions", "GET /v1/live", "GET /v1/agents/{id}/term", "POST /v1/agents"} {
			if got, _ := s.gate(relayedRequest(pattern, "", m.name, m.value)); got != http.StatusUnauthorized {
				t.Errorf("%s via %s: %d, want 401", pattern, m.name, got)
			}
			if got, _ := s.gate(relayedRequest(pattern, "some-token", m.name, m.value)); got != http.StatusUnauthorized {
				t.Errorf("%s via %s with a token: %d, want 401", pattern, m.name, got)
			}
		}
		if got, why := s.gate(relayedRequest("GET /", "", m.name, m.value)); got != 0 {
			t.Errorf("dashboard via %s: %d (%s)", m.name, got, why)
		}
	}
}

// What adds no header — `ssh -R`, `tailscale serve --tcp`, a TCP tunnel —
// still arrives under the name the visitor typed, which is not ours.
func TestALoopbackRequestForAnotherHostIsRelayed(t *testing.T) {
	s, _, viewer, _ := pairedPhones(t, Deps{})
	off := New(Deps{})
	for _, host := range []string{"abc.trycloudflare.com", "mac.tail1234.ts.net", "100.101.102.103:22776", "0.tcp.ngrok.io:12345", "localhost.evil.example", ""} {
		r := phoneRequest("POST /v1/agents", "")
		r.RemoteAddr, r.Host = "127.0.0.1:51000", host
		if got, _ := s.gate(r); got != http.StatusUnauthorized {
			t.Errorf("Host %q, no token: %d, want 401", host, got)
		}
		if got, _ := off.gate(r); got != http.StatusUnauthorized {
			t.Errorf("Host %q, network access off: %d, want 401", host, got)
		}
		r.Header.Set(deviceTokenHeader, viewer.Token)
		if got, _ := s.gate(r); got != http.StatusForbidden {
			t.Errorf("Host %q, viewer: %d, want 403", host, got)
		}
	}
}

// Everything on the machine addresses 127.0.0.1 or localhost — the CLI, the
// hook shim, the statusline, the dashboard, Vite's dev proxy, an `ssh -L` on
// another port — and is the owner as before, network access on or off.
func TestLoopbackClientsAreStillTheOwner(t *testing.T) {
	on, _, _, _ := pairedPhones(t, Deps{})
	off := New(Deps{})
	clients := []struct {
		name, host string
		headers    map[string]string
	}{
		{"cli", "127.0.0.1:22776", map[string]string{"Content-Type": "application/json", "User-Agent": "Go-http-client/1.1"}},
		{"shim", "127.0.0.1:22776", map[string]string{"Authorization": "Bearer t", "Content-Type": "application/json"}},
		{"dashboard", "127.0.0.1:22776", map[string]string{"Origin": "http://127.0.0.1:22776", "Sec-Fetch-Site": "same-origin"}},
		{"localhost", "localhost:22776", map[string]string{"Sec-Fetch-Site": "same-origin"}},
		{"ipv6", "[::1]:22776", nil},
		{"vite dev proxy", "localhost:5173", nil},
		{"ssh -L", "localhost:8080", nil},
		{"websocket", "127.0.0.1:22776", map[string]string{"Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13", "Origin": "http://127.0.0.1:22776"}},
	}
	for _, c := range clients {
		for _, pattern := range []string{"GET /v1/sessions", "GET /v1/live", "GET /v1/agents/{id}/term", "POST /v1/agents", "POST /v1/shutdown", "GET /v1/pair/state"} {
			r := phoneRequest(pattern, "")
			r.RemoteAddr, r.Host = "127.0.0.1:51000", c.host
			if strings.HasPrefix(c.host, "[::1]") {
				r.RemoteAddr = "[::1]:51000"
			}
			for k, v := range c.headers {
				r.Header.Set(k, v)
			}
			for _, s := range []*Server{on, off} {
				if got, why := s.gate(r); got != 0 {
					t.Errorf("%s %s: %d (%s)", c.name, pattern, got, why)
				}
			}
		}
	}
}

// Through the whole stack: a relayed WebSocket upgrade is refused before the
// handshake, and the same upgrade from the machine is not.
func TestARelayedWebSocketIsRefusedBeforeTheHandshake(t *testing.T) {
	s := New(Deps{})
	for _, path := range []string{"/v1/live", "/v1/agents/abc/term"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.RemoteAddr, r.Host = "127.0.0.1:51000", "127.0.0.1:22776"
		r.Header.Set("Connection", "Upgrade")
		r.Header.Set("Upgrade", "websocket")
		r.Header.Set("Sec-WebSocket-Version", "13")
		r.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
		r.Header.Set("X-Forwarded-For", "203.0.113.9")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s relayed: %d, want 401", path, w.Code)
		}
	}
}
