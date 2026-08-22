package api

import (
	"net"
	"net/http"
	"strings"
)

// --- Cross-site request forgery guard for /v1 ---
//
// The daemon listens on loopback with no authentication on most endpoints,
// because "only this machine can reach it" was taken to mean "only this user's
// own tools can reach it". A browser breaks that: any page the user visits
// while the daemon runs can send requests to 127.0.0.1. The same-origin policy
// stops the page *reading* the response — it does not stop the request from
// being sent, and it does not stop what the request does. POST /v1/agents
// executes a command from its body, so a forged request is remote code
// execution from a web page.
//
// The previous guard only rejected a *present* cross-site Origin:
//
//	if o := r.Header.Get("Origin"); o != "" && !isLoopbackOrigin(o) { ... }
//
// Browsers omit Origin entirely on cross-site **simple requests** — a plain
// HTML form POST, or fetch() with a text/plain body — so the check was skipped
// exactly in the case that mattered. A missing Origin is now never trusted for
// a state-changing method.
//
// The guard is layered, because no single signal covers every browser and
// every client:
//
//  1. Sec-Fetch-Site — sent by every current browser on every request and not
//     settable by script. "same-origin"/"none" is the dashboard itself;
//     "cross-site"/"same-site" is refused outright, whatever else the request
//     carries. This is the one signal a forged request cannot fake.
//  2. Origin — when present it must be loopback. A cross-site Origin is
//     refused. This is the pre-existing check, kept.
//  3. Content-Type: application/json — required on a state-changing request
//     with no browser provenance at all (a non-browser client such as curl,
//     the CLI, or the shim). A cross-site *simple* request cannot set this
//     header: doing so forces a CORS preflight, and the preflight is answered
//     by nothing here, so the real request is never sent. A form POST is
//     limited to the three simple content types and so cannot reach an
//     endpoint guarded this way.
//
// Non-browser clients are unaffected: curl and Go's http.Client send neither
// Sec-Fetch-Site nor Origin, and every in-repo client that mutates state
// already sends application/json. GET/HEAD/OPTIONS keep the Origin-only rule —
// they are read-only here — with the exception of the WebSocket upgrades,
// which coder/websocket guards with OriginPatterns (a missing Origin is
// rejected there already).

// safeMethod reports whether a method is read-only for this API, i.e. no
// handler behind it changes state.
//
// GET is on this list only because every GET route on the router is a query.
// The two GET routes that reach a live process — /v1/live and
// /v1/agents/{id}/term — are WebSocket upgrades, and coder/websocket's
// OriginPatterns already refuses a missing or foreign Origin on those, which is
// stricter than anything here. If a future GET gains a side effect, it belongs
// behind a POST, not on this list.
func safeMethod(m string) bool {
	switch m {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	return false
}

// checkOrigin decides whether a /v1 request may proceed. It returns an empty
// string when the request is allowed, or a reason to refuse with 403.
func checkOrigin(r *http.Request) string {
	// Fetch metadata first: a browser always sends it and script cannot forge
	// it, so a cross-site value is decisive regardless of the other headers.
	// It is checked for reads as well as writes — a cross-site page must not be
	// able to read the session list either.
	sfs := r.Header.Get("Sec-Fetch-Site")
	switch sfs {
	case "cross-site", "same-site":
		// "same-site" still means a different origin (a sibling port or scheme
		// on the same registrable domain), which is not the dashboard.
		return "forbidden origin: cross-site request"
	}

	// DNS rebinding: a page on a hostname the attacker controls, pointed at
	// 127.0.0.1, is genuinely same-origin with the daemon — Origin and
	// Sec-Fetch-Site both say "fine" — but the Host header still carries the
	// attacker's name. Checked only for requests that came from a browser
	// (Origin or Sec-Fetch-Site present), because that is the only way such an
	// attack can reach a loopback listener, and because non-browser clients
	// legitimately address the daemon by other names (a test harness, a proxy,
	// an SSH tunnel) with no rebinding risk.
	if (sfs != "" || r.Header.Get("Origin") != "") && !isLoopbackHost(r.Host) {
		return "forbidden host"
	}

	// A present Origin must be loopback, on every method. This is what the
	// dashboard sends, and what a cross-origin fetch() from a page sends.
	if o := r.Header.Get("Origin"); o != "" && !isLoopbackOrigin(o) {
		return "forbidden origin"
	}

	if safeMethod(r.Method) {
		return ""
	}

	// From here the request changes state and carries no proof of being a
	// browser request from the dashboard.
	//
	// If it came from a browser at all, Sec-Fetch-Site says so, and by now it
	// is "same-origin" or "none" — the dashboard itself, or a user typing the
	// URL. Allow it.
	if sfs := r.Header.Get("Sec-Fetch-Site"); sfs != "" {
		return ""
	}

	// No fetch metadata: either a pre-2020 browser or a non-browser client.
	// Two proofs are accepted, and at least one is required.
	//
	// (a) A bearer token. The per-run token lives in runtime.json, mode 0600 in
	// the user's data directory; a web page cannot read it and cannot guess it.
	// A request carrying an Authorization header is therefore not a forgery,
	// whatever else it looks like. This is how `caprock down` authenticates —
	// it POSTs to /v1/shutdown with NO body and so NO Content-Type — and the
	// shim and `caprock statusline` do the same. The handlers still verify the
	// token; this only decides that the request is worth handling.
	//
	// (b) Content-Type: application/json. A cross-site *simple* request cannot
	// set it: doing so forces a CORS preflight, which this server answers for
	// nothing, so the real request is never sent. A form post is limited to
	// the three simple content types and cannot reach an endpoint guarded this
	// way. This is what the dashboard, the CLI's task create, and curl send.
	if r.Header.Get("Authorization") != "" {
		return ""
	}
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return "state-changing requests must send Content-Type: application/json"
	}

	return ""
}

// isJSONContentType reports whether the media type is application/json,
// ignoring parameters and case ("application/json; charset=utf-8").
func isJSONContentType(ct string) bool {
	if ct == "" {
		return false
	}
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	return strings.EqualFold(strings.TrimSpace(ct), "application/json")
}

// isLoopbackHost reports whether a Host header names this machine. Anything
// else means the request arrived under a hostname that resolves here but is not
// ours — the shape of a DNS-rebinding attack.
func isLoopbackHost(host string) bool {
	h := host
	if hh, _, err := net.SplitHostPort(host); err == nil {
		h = hh
	}
	h = strings.Trim(strings.ToLower(h), "[]")
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback()
	}
	return false
}
