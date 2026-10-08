package api

import (
	"context"
	"net"
	"net/http"
	"strings"

	"github.com/dspv/caprock/internal/pairing"
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
// token. Loopback means this machine's own clients: a request a proxy or tunnel
// on the machine relays onto loopback counts as from the network (isLocal).
// A request from the network is a stranger until it proves otherwise,
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
// else is 403 (ADR-029). The owner can make one device a controller, on the
// machine (ADR-034); a controller may also make the requests in
// controllerRoutes — start, type into, answer and stop sessions. Every change
// to settings, tasks or pairing stays on the machine whatever the role.
//
// The failure is 401 with a JSON body rather than a redirect: the caller is
// usually fetch(), and a redirect to an HTML page turns "you are not paired"
// into a parse error three frames later.

// deviceToken is the header a paired device sends. A header rather than a
// cookie: a cookie rides along on requests the user did not make, which is the
// property that makes CSRF possible, and this API runs commands.
const deviceTokenHeader = "X-Caprock-Device"

// isLocal reports whether the request came from this machine: over loopback,
// and not relayed from somewhere else by a proxy or tunnel running on it.
//
// RemoteAddr is the kernel's view of the peer and cannot be set by the caller —
// unlike X-Forwarded-For, which is a claim. But the kernel only names the last
// hop. cloudflared, ngrok, Caddy, `tailscale serve` or an `ssh -R` on the Mac
// all connect from 127.0.0.1 on behalf of somebody else, and believing the
// kernel alone handed that somebody the owner's rights with no token. So a
// loopback request is the owner's only while it looks like one (forwarded).
func isLocal(r *http.Request) bool {
	return fromLoopback(r) && !forwarded(r)
}

// fromLoopback reports whether the kernel saw the peer on a loopback address.
func fromLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Headers a proxy or tunnel adds and no client of ours sends. Their values are
// claims and are never read; their presence is the signal. Canonical form, as
// net/http stores them.
var (
	proxyHeaders = map[string]bool{
		"Forwarded":      true,
		"Via":            true,
		"X-Real-Ip":      true,
		"True-Client-Ip": true,
	}
	proxyHeaderPrefixes = []string{
		"X-Forwarded-", // -For, -Host, -Proto, -Port, … (Caddy, nginx, ngrok, tailscale serve)
		"Cf-",          // Cf-Connecting-Ip, Cf-Ray, … (cloudflared)
		"Tailscale-",   // Tailscale-User-Login, … (tailscale serve)
		"Ngrok-",
		"X-Ngrok-",
	}
)

// forwarded reports whether a request carries the marks of having been relayed:
// a proxy header, or a Host that does not name this machine.
//
// The Host test catches what adds no header — `ssh -R`, `tailscale serve
// --tcp`, a TCP tunnel — because the visitor addressed the relay, not us. Only
// the hostname is compared: `ssh -L 8080:127.0.0.1:22776` sends
// localhost:8080 and is the owner, and a relay that rewrites Host could write
// our port as easily. Every client of ours (the CLI, the shim, the statusline,
// the dashboard, Vite's dev proxy) addresses 127.0.0.1 or localhost. An empty
// Host is refused too: HTTP/1.0 allows it and no client of ours sends one.
//
// A relay set up to strip every one of these and rewrite Host to localhost is
// indistinguishable from a local client; only the owner can configure that.
func forwarded(r *http.Request) bool {
	if !isLoopbackHost(r.Host) {
		return true
	}
	for name := range r.Header {
		if proxyHeaders[name] {
			return true
		}
		for _, p := range proxyHeaderPrefixes {
			if strings.HasPrefix(name, p) {
				return true
			}
		}
	}
	return false
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
	status, reason, _ := s.gateDevice(r)
	return status == 0, reason
}

// gate is allowRequest with the status to refuse with: 0 to serve, 401 for a
// device that has not proved itself, 403 for a paired device asking for more
// than its role allows.
func (s *Server) gate(r *http.Request) (status int, reason string) {
	status, reason, _ = s.gateDevice(r)
	return status, reason
}

// The two refusals a paired device can get, said so the person holding it
// knows what to do next. A viewer is told where control is granted; a
// controller asking for something only the machine does is told so.
const (
	viewerRefusal     = "this device can read Caprock, not control it"
	controllerRefusal = "this is done on the machine Caprock runs on"
)

// gateDevice is gate, plus the device that is asking when the request came
// from one. The device is a copy taken at the moment of the check (see
// pairing.Store.Check), and nil for loopback and for a daemon with network
// access off.
func (s *Server) gateDevice(r *http.Request) (status int, reason string, dev *pairing.Device) {
	if isLocal(r) {
		return 0, "", nil
	}
	// Not local, and LAN access was never turned on: there is no listener on
	// any other address, so this cannot be a request off the network. It is a
	// test's synthetic RemoteAddr, or a caller reaching loopback by a route the
	// kernel labels differently. Behave exactly as before the feature existed —
	// a gate that changes what happens when it is switched off is a gate nobody
	// can reason about.
	//
	// Except a request relayed onto loopback by a proxy or tunnel on this
	// machine: that one did come off the network, through a listener that is
	// not ours, and with network access off there is no device it could be.
	ps, _ := s.lanState()
	relayed := fromLoopback(r)
	if ps == nil && !relayed {
		return 0, "", nil
	}
	if openToUnpairedDevices(r.URL.Path) {
		return 0, "", nil
	}
	tok := deviceTokenOf(r)
	if tok == "" || ps == nil {
		return http.StatusUnauthorized, "this device is not paired with Caprock", nil
	}
	dev, err := ps.Check(tok)
	if err != nil {
		// One message for an unknown token and a revoked one. Telling them
		// apart tells a stranger which of their guesses was once real.
		return http.StatusUnauthorized, "this device is not paired with Caprock", nil
	}
	switch s.deviceMay(r, dev.Role) {
	case mayServe:
		return 0, "", dev
	case mayIfController:
		return http.StatusForbidden, viewerRefusal, dev
	default:
		if dev.Role == pairing.RoleController {
			return http.StatusForbidden, controllerRefusal, dev
		}
		return http.StatusForbidden, viewerRefusal, dev
	}
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
//     A controller has it (controllerRoutes).
//   - /v1/browse — a directory listing of this machine, there for the folder
//     picker. A controller has it, rooted inside home (controllerRoutes).
//   - /v1/recent-dirs — the projects a controller picks from, and nothing a
//     viewer needs.
//   - /v1/pair/state — pairing is managed from the machine, and its handler
//     refuses the network anyway.
var pairedDeviceRoutes = map[string]bool{
	"GET /v1/sessions":                true,
	"GET /v1/sessions/{id}":           true,
	"GET /v1/sessions/{id}/events":    true,
	"GET /v1/sessions/{id}/subagents": true,
	"GET /v1/sessions/{id}/notes":     true,
	"GET /v1/sessions/{id}/diff":      true,
	"GET /v1/notes":                   true,
	"GET /v1/stats/summary":           true,
	"GET /v1/stats/daily":             true,
	"GET /v1/events":                  true,
	"GET /v1/history":                 true,
	"GET /v1/status":                  true,
	"GET /v1/storage":                 true, // sizes only; the data dir is already in /v1/status
	"GET /v1/update":                  true,
	"GET /v1/settings":                true, // without the licence key; see handleGetSettings
	"GET /v1/premium":                 true,
	"GET /v1/gemini":                  true,
	"GET /v1/pricing":                 true,
	"GET /v1/live":                    true,
	"GET /v1/tasks":                   true,
	"GET /v1/tasks/{id}":              true,
	"GET /v1/approvals":               true,
	"GET /v1/statusline/{id}":         true,
	"GET /v1/pair/me":                 true, // which role this device holds, so its screens draw the right controls
	"GET /v1/glance":                  true, // Now's At a glance
	"GET /v1/week":                    true, // the Week screen
	"GET /v1/tools/drill":             true, // the tool drill-down; its Premium half is gated in the handler

	// The permission prompt an owned session waits on (ADR-035); the live
	// socket already carries it to a viewer.
	"GET /v1/agents/{id}/permission": true,

	// The projects list, a project's worktrees and the clones in flight
	// (WP-05, WP-08): what the sidebar shows, as the session list is.
	"GET /v1/projects":                true,
	"GET /v1/projects/ops":            true,
	"GET /v1/projects/{id}/worktrees": true,

	// A worktree's status and one file's diff (the Changes view), as a
	// session's diff is a read.
	"GET /v1/projects/{id}/changes":      true,
	"GET /v1/projects/{id}/changes/diff": true,

	// GitHub (WP-19): the connection's state (never the token), the clone
	// picker's lists, and each worktree's pull request with its checks and
	// reviews. The daemon makes the calls; the token never leaves it.
	"GET /v1/github":               true,
	"GET /v1/github/owners":        true,
	"GET /v1/github/repos":         true,
	"GET /v1/github/prs":           true,
	"GET /v1/projects/{id}/github": true,
}

// What a controller may do on top of reading (ADR-034), named one route at a
// time for the same reason as above.
//
// The test for a route being here: it is something a person does to a session
// away from the desk — start one in a folder under home, carry one on,
// type into it, answer it, attach a photo to it, stop it — and it acts only on
// what Caprock itself started (rule 7 is enforced below this, in the agent
// manager, whoever asks).
//
// Deliberately absent although a controller is trusted to type:
//
//   - POST /v1/sessions/{id}/open-terminal — it opens a window on the Mac's
//     screen, which is not where the phone's owner is looking.
//   - GET /v1/editors, POST /v1/editors/open — the same, for an editor; the
//     handlers refuse anything not local as well (editor.go).
//   - /v1/settings, /v1/pair*, /v1/hive, POST /v1/tasks, /v1/orchestrator/*,
//     /v1/hooks/install, /v1/shutdown, /v1/update/check, /v1/report/test,
//     /v1/gemini/ask — configuration of the machine, starting a fleet, or an
//     outbound call; none of them is "work on a session".
//   - POST /v1/tasks/{id}/verify — it runs the task's done-criteria commands.
var controllerRoutes = map[string]bool{
	"POST /v1/agents":             true, // start or continue a session; narrowed further in handleSpawn
	"GET /v1/agents/models":       true, // the start form's model list
	"GET /v1/recent-dirs":         true, // the start form's project list
	"GET /v1/browse":              true, // the start form's folder picker, rooted inside home (handleBrowse)
	"GET /v1/sessions/{id}/relay": true, // the brief a relay offers, to read before starting it
	"GET /v1/agents/{id}/term":    true, // the terminal: output, and typing
	"POST /v1/agents/{id}/input":  true,
	"POST /v1/agents/{id}/signal": true, // pause, resume, stop
	"POST /v1/paste":              true, // a photo or file from the phone, typed in as its path
	"POST /v1/tasks/{id}/approve": true,
	"POST /v1/tasks/{id}/reject":  true,

	// Answer a permission prompt with a button (ADR-035).
	"POST /v1/agents/{id}/permission": true,

	// Start work from the phone (21-app.md decision 8, ADR-034 amended):
	// add, create or clone a project under home, rename, pin or unlist one
	// (unlisting deletes nothing), and create or remove a worktree in one
	// under home. The folder checks are in the handlers. Shells are not
	// here: from the phone they are P1.
	"POST /v1/projects":                         true,
	"PATCH /v1/projects/{id}":                   true,
	"DELETE /v1/projects/{id}":                  true,
	"POST /v1/projects/{id}/worktrees":          true,
	"DELETE /v1/projects/{id}/worktrees/{name}": true,

	// Finish the work from the phone (ADR-034 amended 2026-10-06): stage,
	// unstage, discard (two-step), commit, push (never forced), pull
	// (fast-forward only) and fetch, in a worktree under home (changes.go).
	"POST /v1/projects/{id}/changes/stage":   true,
	"POST /v1/projects/{id}/changes/unstage": true,
	"POST /v1/projects/{id}/changes/discard": true,
	"POST /v1/projects/{id}/changes/commit":  true,
	"POST /v1/projects/{id}/changes/push":    true,
	"POST /v1/projects/{id}/changes/pull":    true,
	"POST /v1/projects/{id}/changes/fetch":   true,

	// Open a pull request from a worktree under home (pushing it first,
	// as the push above would), and read its state again now (WP-19).
	// Connecting GitHub and creating a repository stay on the machine.
	"POST /v1/projects/{id}/github/pr":      true,
	"POST /v1/projects/{id}/github/refresh": true,
}

// deviceVerdict is what a role may do with one request.
type deviceVerdict int

const (
	mayNot          deviceVerdict = iota // no device may
	mayIfController                      // a controller may, a viewer may not
	mayServe                             // this device may
)

// deviceMay decides one request from a paired device holding role.
func (s *Server) deviceMay(r *http.Request, role string) deviceVerdict {
	if !strings.HasPrefix(r.URL.Path, "/v1/") {
		// The dashboard's own files and /healthz, open even before pairing.
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			return mayServe
		}
		return mayNot
	}
	_, pattern := s.mux.Handler(r)
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) && pairedDeviceRoutes[pattern] {
		return mayServe
	}
	if !controllerRoutes[pattern] || !controllerMethod(r.Method, pattern) {
		return mayNot
	}
	if role == pairing.RoleController {
		return mayServe
	}
	return mayIfController
}

// controllerMethod reports whether method is the one pattern names. The
// router already dispatches by method, so a POST to a GET-only route matches
// no pattern of ours; this keeps a HEAD on a GET route behaving as the router
// would and rules out anything else reaching a controller route by accident.
func controllerMethod(method, pattern string) bool {
	m, _, _ := strings.Cut(pattern, " ")
	if m == http.MethodGet {
		return method == http.MethodGet || method == http.MethodHead
	}
	return method == m
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
//
// It returns the request to carry on with: the same one for loopback, and one
// whose context names the device for a request from the network, so handlers
// can audit and narrow what a controller does (deviceFrom).
func (s *Server) pairingGate(w http.ResponseWriter, r *http.Request) (*http.Request, bool) {
	status, reason, dev := s.gateDevice(r)
	if status == 0 {
		if dev != nil {
			r = r.WithContext(context.WithValue(r.Context(), deviceKey{}, dev))
		}
		return r, true
	}
	detail := "Open Caprock on the machine it runs on, turn on network access, and pair this device with the code it shows."
	if status == http.StatusForbidden {
		if reason == viewerRefusal {
			detail = "To start, type into or stop sessions from here, open Settings on the machine Caprock runs on and choose \u201cLet it control sessions\u201d beside this device."
		} else {
			detail = "Settings, pairing, the task runner and opening a terminal window happen on the machine Caprock runs on."
		}
	}
	writeJSON(w, status, map[string]string{"error": reason, "detail": detail})
	return r, false
}

// deviceKey carries the paired device that made a request, in its context.
type deviceKey struct{}

// deviceFrom is the paired device that made r, or nil for a request from this
// machine (or from anywhere while network access is off).
func deviceFrom(r *http.Request) *pairing.Device {
	d, _ := r.Context().Value(deviceKey{}).(*pairing.Device)
	return d
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
