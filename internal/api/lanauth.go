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
	if isLocal(r) {
		return true, ""
	}
	// Not local, and LAN access was never turned on: there is no listener on
	// any other address, so this cannot be a request off the network. It is a
	// test's synthetic RemoteAddr, or a caller reaching loopback by a route the
	// kernel labels differently. Behave exactly as before the feature existed —
	// a gate that changes what happens when it is switched off is a gate nobody
	// can reason about.
	if s.d.Pairing == nil {
		return true, ""
	}
	if openToUnpairedDevices(r.URL.Path) {
		return true, ""
	}
	tok := deviceTokenOf(r)
	if tok == "" {
		return false, "this device is not paired with Caprock"
	}
	if _, err := s.d.Pairing.Check(tok); err != nil {
		// One message for an unknown token and a revoked one. Telling them
		// apart tells a stranger which of their guesses was once real.
		return false, "this device is not paired with Caprock"
	}
	return true, ""
}

// pairingGate refuses a networked request that has not proved itself.
func (s *Server) pairingGate(w http.ResponseWriter, r *http.Request) bool {
	ok, reason := s.allowRequest(r)
	if ok {
		return true
	}
	writeJSON(w, http.StatusUnauthorized, map[string]string{
		"error":  reason,
		"detail": "Open Caprock on the machine it runs on, turn on network access, and pair this device with the code it shows.",
	})
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
