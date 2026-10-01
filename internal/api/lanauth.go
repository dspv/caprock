package api

import (
	"net"
	"net/http"
	"strings"
)

// Who is allowed in, and from where.
//
// Bound to loopback alone, the answer was "anything that can open a socket to
// this machine", and that was the whole security model: to reach the daemon you
// had to already be on the machine. LAN access breaks that premise — every
// device on the network can now open the socket — so the premise has to be
// replaced rather than stretched.
//
// The replacement is one rule: **a request that did not come from this machine
// must carry a device token.** Loopback keeps working exactly as before, so
// nothing about the local experience changes and no existing client needs a
// token. A request from the network is a stranger until it proves otherwise,
// and it proves it with a token issued in exchange for a code the owner read
// off their own screen.
//
// Three things are deliberately reachable without a token, and only three:
//
//   - the pairing endpoint itself, or there would be no way in;
//   - the dashboard's own files, so the page that asks for the code can load;
//   - nothing else. Not the session list, not costs, not the event stream.
//
// And a token makes a device a reader, not the owner: past the gate, a paired
// device may make only the reads listed in pairedDeviceRoutes, and anything
// else is 403. Starting, typing into, pausing or stopping a session, and every
// change to settings, tasks or pairing, stay on the machine (ADR-029).
//
// The failure is 401 with a JSON body rather than a redirect: the caller is
// usually fetch(), and a redirect to an HTML page turns "you are not paired"
// into a parse error three frames later.

// deviceToken is the header a paired device sends. A header rather than a
// cookie: a cookie rides along on requests the user did not make, which is the
// property that makes CSRF possible, and this API runs commands.
const deviceTokenHeader = "X-Caprock-Device"

// isLocal reports whether the request arrived over loopback.
//
// RemoteAddr is the kernel's view of the peer and cannot be set by the caller —
// unlike X-Forwarded-For, which is a claim. Caprock sits behind no proxy by
// design, so the kernel's answer is the only one worth reading.
func isLocal(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// openToUnpairedDevices reports whether a path may be served to a device that
// has not paired yet — the pairing endpoint, and the files of the page that
// calls it.
func openToUnpairedDevices(path string) bool {
	switch {
	case path == "/v1/pair":
		return true
	case strings.HasPrefix(path, "/v1/"):
		// Every other API path is closed. Listed this way round on purpose: a
		// new endpoint is private until someone decides otherwise, rather than
		// public until someone remembers.
		return false
	default:
		// The dashboard's own assets. They contain no data — the figures all
		// arrive over /v1 — and without them the pairing screen cannot render.
		return true
	}
}

// allowRequest decides whether to serve r, and returns the reason when not.
func (s *Server) allowRequest(r *http.Request) (ok bool, reason string) {
	status, reason := s.gate(r)
	return status == 0, reason
}

// gate is allowRequest with the status to refuse with: 0 to serve, 401 for a
// device that has not proved itself, 403 for a paired device asking for more
// than a paired device may do.
func (s *Server) gate(r *http.Request) (status int, reason string) {
	if isLocal(r) {
		return 0, ""
	}
	// Not local, and LAN access was never turned on: there is no listener on
	// any other address, so this cannot be a request off the network. It is a
	// test's synthetic RemoteAddr, or a caller reaching loopback by a route the
	// kernel labels differently. Behave exactly as before the feature existed —
	// a gate that changes what happens when it is switched off is a gate nobody
	// can reason about.
	ps, _ := s.lanState()
	if ps == nil {
		return 0, ""
	}
	if openToUnpairedDevices(r.URL.Path) {
		return 0, ""
	}
	tok := deviceTokenOf(r)
	if tok == "" {
		return http.StatusUnauthorized, "this device is not paired with Caprock"
	}
	if _, err := ps.Check(tok); err != nil {
		// One message for an unknown token and a revoked one. Telling them
		// apart tells a stranger which of their guesses was once real.
		return http.StatusUnauthorized, "this device is not paired with Caprock"
	}
	if !s.pairedDeviceMay(r) {
		return http.StatusForbidden, "a paired device can read Caprock, not control it"
	}
	return 0, ""
}

// What a paired device may do, named one route at a time.
//
// ADR-029: a tablet is somewhere to read figures, not a second control room.
// The token proves which device is asking; it does not make that device the
// owner. Until this list existed the token was the whole check, so a paired
// phone could start a command (POST /v1/agents), type into a session, kill
// one, change settings, approve a task or start the orchestrator — everything
// the laptop's own dashboard can do.
//
// An allowlist of method and route, not a denylist: a route added next year is
// closed to the tablet until someone decides it is a read and names it here.
// Matched against the pattern the router itself dispatches to, so
// `/v1/sessions/{id}` covers every id and nothing else, and a HEAD reaches a
// GET route the way the router does.
//
// Deliberately absent although they are GETs:
//
//   - /v1/agents/{id}/term — a WebSocket that writes every frame it receives
//     into the session's terminal. Its method says read; it is a keyboard.
//   - /v1/browse and /v1/recent-dirs — directory listings of this machine,
//     there for the folder picker that starts a session, which a paired
//     device cannot do.
//   - /v1/pair/state — pairing is managed from the machine, and its handler
//     refuses the network anyway.
var pairedDeviceRoutes = map[string]bool{
	"GET /v1/sessions":             true,
	"GET /v1/sessions/{id}":        true,
	"GET /v1/sessions/{id}/events": true,
	"GET /v1/sessions/{id}/notes":  true,
	"GET /v1/sessions/{id}/diff":   true,
	"GET /v1/notes":                true,
	"GET /v1/stats/summary":        true,
	"GET /v1/stats/daily":          true,
	"GET /v1/events":               true,
	"GET /v1/history":              true,
	"GET /v1/status":               true,
	"GET /v1/storage":              true, // sizes only; the data dir is already in /v1/status
	"GET /v1/update":               true,
	"GET /v1/settings":             true, // without the licence key; see handleGetSettings
	"GET /v1/premium":              true,
	"GET /v1/gemini":               true,
	"GET /v1/pricing":              true,
	"GET /v1/live":                 true,
	"GET /v1/tasks":                true,
	"GET /v1/tasks/{id}":           true,
	"GET /v1/approvals":            true,
	"GET /v1/statusline/{id}":      true,
}

// pairedDeviceMay reports whether a paired device may make r.
func (s *Server) pairedDeviceMay(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if !strings.HasPrefix(r.URL.Path, "/v1/") {
		// The dashboard's own files and /healthz, open even before pairing.
		return true
	}
	_, pattern := s.mux.Handler(r)
	return pairedDeviceRoutes[pattern]
}

// fromPairedDevice reports whether r came over the network from a paired
// device rather than from this machine. Meaningful only for a request the gate
// has already let through.
func (s *Server) fromPairedDevice(r *http.Request) bool {
	if isLocal(r) {
		return false
	}
	ps, _ := s.lanState()
	return ps != nil
}

// pairingGate refuses a networked request that has not proved itself, and a
// paired device asking for more than reading.
func (s *Server) pairingGate(w http.ResponseWriter, r *http.Request) bool {
	status, reason := s.gate(r)
	if status == 0 {
		return true
	}
	detail := "Open Caprock on the machine it runs on, turn on network access, and pair this device with the code it shows."
	if status == http.StatusForbidden {
		detail = "Starting, typing into, pausing or stopping sessions, and changing settings, tasks or pairing, happen on the machine Caprock runs on."
	}
	writeJSON(w, status, map[string]string{"error": reason, "detail": detail})
	return false
}

// deviceTokenOf reads the device token from wherever this request could carry
// one.
//
// A normal fetch() sends a header. A WebSocket cannot: the browser's
// constructor takes a URL and a list of subprotocols and nothing else, so the
// token rides in as `caprock.device.<token>` and the server echoes it back to
// complete the handshake. Not a query parameter, which would be written into
// every access log and every browser history entry on the device.
func deviceTokenOf(r *http.Request) string {
	if t := r.Header.Get(deviceTokenHeader); t != "" {
		return t
	}
	for _, p := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		p = strings.TrimSpace(p)
		if after, ok := strings.CutPrefix(p, "caprock.device."); ok {
			return after
		}
	}
	return ""
}
