package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// csrfEnv builds a server whose spawn/task/settings endpoints are reachable, so
// a refusal is provably the guard and not a 501 from an absent controller.
func csrfEnv(t *testing.T) *env {
	t.Helper()
	return newEnv(t)
}

// do sends a request with the given headers and returns the status.
func do(t *testing.T, e *env, method, path, body string, hdr map[string]string) int {
	t.Helper()
	var rdr *strings.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	var req *http.Request
	var err error
	if rdr != nil {
		req, err = http.NewRequest(method, e.srv.URL+path, rdr)
	} else {
		req, err = http.NewRequest(method, e.srv.URL+path, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

// TestCSRFNoOriginFormPostRefused is the exact reported bug: a cross-site HTML
// form POST. A browser sends NO Origin on such a request, so the old
// `o != "" && !isLoopbackOrigin(o)` check skipped the guard entirely and the
// body reached the spawn handler, which executes `command`.
//
// The two shapes below are the ones a page can actually produce cross-site
// without a CORS preflight: a form post (application/x-www-form-urlencoded)
// and fetch() with text/plain. Both must be refused.
func TestCSRFNoOriginFormPostRefused(t *testing.T) {
	e := csrfEnv(t)
	for _, tc := range []struct {
		name string
		ct   string
	}{
		{"form", "application/x-www-form-urlencoded"},
		{"textplain", "text/plain;charset=UTF-8"},
		{"multipart", "multipart/form-data; boundary=x"},
		{"nocontenttype", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hdr := map[string]string{}
			if tc.ct != "" {
				hdr["Content-Type"] = tc.ct
			}
			// No Origin header at all — precisely what a browser sends on a
			// cross-site simple request.
			if code := do(t, e, http.MethodPost, "/v1/agents",
				`{"cwd":"/tmp","command":"/bin/echo pwned"}`, hdr); code != http.StatusForbidden {
				t.Fatalf("POST /v1/agents with no Origin and %q: got %d, want 403", tc.ct, code)
			}
		})
	}
}

// TestCSRFNoOriginRefusedOnEveryMutatingRoute covers the rest of the reachable
// state-changing surface, so a future route added without thought is caught.
func TestCSRFNoOriginRefusedOnEveryMutatingRoute(t *testing.T) {
	e := csrfEnv(t)
	for _, r := range []struct{ method, path, body string }{
		{http.MethodPost, "/v1/agents", `{"cwd":"/tmp","command":"/bin/echo"}`},
		{http.MethodPost, "/v1/agents/x/input", `{"data":"rm -rf /\n"}`},
		{http.MethodPost, "/v1/agents/x/signal", `{"action":"kill"}`},
		{http.MethodPost, "/v1/orchestrator/start", ``},
		{http.MethodPost, "/v1/orchestrator/stop", ``},
		{http.MethodPost, "/v1/hive", `{"hive":"/tmp/h"}`},
		{http.MethodPut, "/v1/settings", `{"update_checks":true}`},
		{http.MethodPost, "/v1/tasks", `{"title":"x"}`},
		{http.MethodPost, "/v1/update/check", ``},
	} {
		// A cross-site simple request: no Origin, form content type.
		code := do(t, e, r.method, r.path, r.body,
			map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
		if code != http.StatusForbidden {
			t.Errorf("%s %s cross-site simple request: got %d, want 403", r.method, r.path, code)
		}
	}
}

// TestCSRFCrossSiteOriginRefused covers the case the old code did handle, so
// the rewrite does not lose it — including when the request otherwise looks
// perfect (JSON content type, which a page can only send with a preflight).
func TestCSRFCrossSiteOriginRefused(t *testing.T) {
	e := csrfEnv(t)
	for _, o := range []string{
		"https://evil.example",
		"http://evil.example",
		"http://localhost.evil.example", // prefix-matching trap
		"http://127.0.0.1.evil.example",
		"null",
	} {
		if code := do(t, e, http.MethodPost, "/v1/agents", `{"cwd":"/tmp"}`,
			map[string]string{"Content-Type": "application/json", "Origin": o}); code != http.StatusForbidden {
			t.Errorf("POST with Origin %q: got %d, want 403", o, code)
		}
	}
}

// TestCSRFSecFetchSiteCrossSiteRefused proves the fetch-metadata layer stands
// on its own: even a request that carries a loopback Origin and a JSON content
// type is refused when the browser itself says it is cross-site. Sec-Fetch-Site
// cannot be set by script, so this is the signal a forgery cannot fake.
func TestCSRFSecFetchSiteCrossSiteRefused(t *testing.T) {
	e := csrfEnv(t)
	for _, sfs := range []string{"cross-site", "same-site"} {
		if code := do(t, e, http.MethodPost, "/v1/agents", `{"cwd":"/tmp"}`, map[string]string{
			"Content-Type": "application/json", "Origin": "http://localhost:4173", "Sec-Fetch-Site": sfs,
		}); code != http.StatusForbidden {
			t.Errorf("POST with Sec-Fetch-Site %q: got %d, want 403", sfs, code)
		}
		// Reads are refused cross-site too — a page must not read the session list.
		if code := do(t, e, http.MethodGet, "/v1/sessions", "", map[string]string{
			"Sec-Fetch-Site": sfs,
		}); code != http.StatusForbidden {
			t.Errorf("GET with Sec-Fetch-Site %q: got %d, want 403", sfs, code)
		}
	}
}

// TestCSRFDashboardOriginAccepted is the must-not-break case: the real request
// the embedded dashboard sends. ui/src/lib/api.ts posts with
// `Content-Type: application/json`, and the browser adds Origin plus
// Sec-Fetch-Site: same-origin. A 403 here would mean the fix broke the product.
//
// 501 is the expected answer from these handlers in this harness (no agents or
// tasks controller is wired) — the point is that the request got PAST the
// guard and reached the handler.
func TestCSRFDashboardOriginAccepted(t *testing.T) {
	e := csrfEnv(t)
	for _, o := range []string{
		"http://localhost:4173",
		"http://127.0.0.1:4173",
		"http://localhost:5173", // the Vite dev server, which proxies /v1
		"http://[::1]:4173",
	} {
		code := do(t, e, http.MethodPost, "/v1/agents", `{"cwd":"/tmp"}`, map[string]string{
			"Content-Type": "application/json", "Origin": o, "Sec-Fetch-Site": "same-origin",
		})
		if code == http.StatusForbidden {
			t.Errorf("dashboard POST from %q was refused (403); the fix breaks the UI", o)
		}
	}
	// PUT /v1/settings is wired in this harness only when Settings is set; the
	// guard must at minimum not be what refuses it.
	if code := do(t, e, http.MethodPut, "/v1/settings", `{"update_checks":true}`, map[string]string{
		"Content-Type": "application/json", "Origin": "http://localhost:4173", "Sec-Fetch-Site": "same-origin",
	}); code == http.StatusForbidden {
		t.Error("dashboard PUT /v1/settings was refused (403)")
	}
}

// TestCSRFAddressBarNavigationAccepted: Sec-Fetch-Site: none is a user typing
// the URL or a bookmark. That is the dashboard being opened, not a forgery.
func TestCSRFAddressBarNavigationAccepted(t *testing.T) {
	e := csrfEnv(t)
	if code := do(t, e, http.MethodGet, "/v1/sessions", "", map[string]string{
		"Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate",
	}); code != http.StatusOK {
		t.Fatalf("address-bar GET: got %d, want 200", code)
	}
}

// --- the real in-repo clients ---
//
// Each of these reproduces the exact request an existing client sends. They are
// written from the call sites, not from an idealised shape:
//
//   - internal/shim/shim.go:60      POST /v1/hook, Content-Type: application/json, Bearer
//   - internal/statusline:158       POST /v1/statusline, Content-Type: application/json, Bearer
//   - cmd/caprock/main.go:385       POST /v1/shutdown, NO body, NO Content-Type, Bearer
//   - cmd/caprock/main.go:707       POST /v1/tasks via http.Post(..., "application/json", ...)
//   - cmd/caprock/main.go:621,429   GET /v1/tasks, GET /v1/status
//   - cmd/caprock/main.go:781       GET /healthz
//
// None of them sends an Origin or Sec-Fetch-Site header — they are Go clients.

// TestCSRFShimRequestShapeStillWorks: the hook shim's real request. Rule 3 says
// the shim must never break a user's Claude session, so a 403 here would be a
// silent capture failure on every hook.
func TestCSRFShimRequestShapeStillWorks(t *testing.T) {
	e := csrfEnv(t)
	body := `{"session_id":"csrf-shim","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"x"},"tool_use_id":"t1","cwd":"/p"}`
	code := do(t, e, http.MethodPost, "/v1/hook", body, map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Bearer tok",
	})
	// The hook receiver answers 204 for a non-Stop event (nothing to say back
	// to Claude Code). Anything but a 2xx would mean the guard ate the hook.
	if code/100 != 2 {
		t.Fatalf("shim POST /v1/hook: got %d, want 2xx", code)
	}
}

// TestCSRFStatuslineRequestShapeStillWorks: `caprock statusline` relays plan
// windows with the same shape as the shim.
func TestCSRFStatuslineRequestShapeStillWorks(t *testing.T) {
	e := csrfEnv(t)
	body := `{"session_id":"s1","five_hour":{"used_percentage":10,"resets_at":0}}`
	code := do(t, e, http.MethodPost, "/v1/statusline", body, map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Bearer tok",
	})
	if code != http.StatusNoContent {
		t.Fatalf("statusline POST: got %d, want 204", code)
	}
}

// TestCSRFCLIDownRequestShapeStillWorks: `caprock down` posts to /v1/shutdown
// with NO body and therefore NO Content-Type — only a Bearer token. This is the
// one in-repo mutating client that sends no JSON header, and the reason the
// guard requires application/json only when a body is present is exactly this
// call site. It is already authenticated by the per-run token, which a web page
// cannot read.
func TestCSRFCLIDownRequestShapeStillWorks(t *testing.T) {
	e := csrfEnv(t)
	// Reproduces cmd/caprock/main.go:385-387 verbatim: MethodPost, nil body,
	// Authorization only.
	req, err := http.NewRequest(http.MethodPost, e.srv.URL+"/v1/shutdown", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer tok")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("caprock down POST /v1/shutdown: got %d, want 200", resp.StatusCode)
	}
}

// TestCSRFCLITaskCreateShapeStillWorks: `caprock task create` uses http.Post
// with the "application/json" content type (cmd/caprock/main.go:707). It must
// reach the handler; 501 (no task runner in this harness) proves it did.
func TestCSRFCLITaskCreateShapeStillWorks(t *testing.T) {
	e := csrfEnv(t)
	code := do(t, e, http.MethodPost, "/v1/tasks",
		`{"title":"t","budget_usd":1,"done_criteria":["true"],"body":"b"}`,
		map[string]string{"Content-Type": "application/json"})
	if code == http.StatusForbidden {
		t.Fatalf("caprock task create was refused by the origin guard (403)")
	}
}

// TestCSRFCLIReadsStillWork: `caprock tasks`, `caprock status` and the health
// probe are plain Go GETs with no headers at all.
func TestCSRFCLIReadsStillWork(t *testing.T) {
	e := csrfEnv(t)
	for _, p := range []string{"/v1/status", "/healthz"} {
		if code := do(t, e, http.MethodGet, p, "", nil); code != http.StatusOK {
			t.Errorf("CLI GET %s: got %d, want 200", p, code)
		}
	}
	// /v1/tasks answers 501 without a runner, but must not be 403.
	if code := do(t, e, http.MethodGet, "/v1/tasks", "", nil); code == http.StatusForbidden {
		t.Error("CLI GET /v1/tasks was refused by the origin guard")
	}
}

// TestCSRFCurlStillWorks: a bare `curl -X POST -d '{}' -H 'Content-Type:
// application/json'` — the documented way to drive the API by hand.
func TestCSRFCurlStillWorks(t *testing.T) {
	e := csrfEnv(t)
	if code := do(t, e, http.MethodPost, "/v1/hive", `{}`,
		map[string]string{"Content-Type": "application/json"}); code == http.StatusForbidden {
		t.Fatal("curl-style JSON POST was refused (403)")
	}
}

// TestIsLoopbackHost guards the DNS-rebinding layer directly.
func TestIsLoopbackHost(t *testing.T) {
	for _, tc := range []struct {
		host string
		want bool
	}{
		{"127.0.0.1:4173", true},
		{"localhost:4173", true},
		{"localhost", true},
		{"[::1]:4173", true},
		{"127.0.0.2:4173", true}, // the whole 127/8 loopback range
		{"evil.example:4173", false},
		{"localhost.evil.example:4173", false},
		{"192.168.1.5:4173", false},
		{"", false},
	} {
		if got := isLoopbackHost(tc.host); got != tc.want {
			t.Errorf("isLoopbackHost(%q) = %v, want %v", tc.host, got, tc.want)
		}
	}
}

// TestIsJSONContentType covers the parameterised and cased forms a real client
// sends, and the simple types a forged form post is limited to.
func TestIsJSONContentType(t *testing.T) {
	for _, tc := range []struct {
		ct   string
		want bool
	}{
		{"application/json", true},
		{"application/json; charset=utf-8", true},
		{"APPLICATION/JSON", true},
		{" application/json ", true},
		{"text/plain", false},
		{"application/x-www-form-urlencoded", false},
		{"multipart/form-data; boundary=x", false},
		{"application/jsonx", false},
		{"", false},
	} {
		if got := isJSONContentType(tc.ct); got != tc.want {
			t.Errorf("isJSONContentType(%q) = %v, want %v", tc.ct, got, tc.want)
		}
	}
}

// TestCSRFGuardDoesNotTouchDashboardAssets: the guard is scoped to /v1. The SPA
// at "/" must still load however the browser asks for it.
func TestCSRFGuardDoesNotTouchDashboardAssets(t *testing.T) {
	e := csrfEnv(t)
	req, _ := http.NewRequest(http.MethodGet, e.srv.URL+"/some/spa/route", nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("SPA route: got %d, want 200", resp.StatusCode)
	}
}

// TestCheckOriginUnit exercises checkOrigin directly, so the decision table is
// readable without a server.
func TestCheckOriginUnit(t *testing.T) {
	mk := func(method string, hdr map[string]string) *http.Request {
		r := httptest.NewRequest(method, "http://127.0.0.1:4173/v1/agents", strings.NewReader("{}"))
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		return r
	}
	for _, tc := range []struct {
		name    string
		method  string
		hdr     map[string]string
		allowed bool
	}{
		{"post no headers at all", http.MethodPost, nil, false},
		{"post json only", http.MethodPost, map[string]string{"Content-Type": "application/json"}, true},
		{"post form only", http.MethodPost, map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, false},
		{"get no headers", http.MethodGet, nil, true},
		{"get cross-site", http.MethodGet, map[string]string{"Sec-Fetch-Site": "cross-site"}, false},
		{"post same-origin", http.MethodPost, map[string]string{"Sec-Fetch-Site": "same-origin"}, true},
		{"post foreign origin json", http.MethodPost, map[string]string{"Origin": "https://evil.example", "Content-Type": "application/json"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := checkOrigin(mk(tc.method, tc.hdr)) == ""
			if got != tc.allowed {
				t.Fatalf("allowed = %v, want %v (reason %q)", got, tc.allowed, checkOrigin(mk(tc.method, tc.hdr)))
			}
		})
	}
}

// TestCSRFRebindingHostRefused: a page on a hostname the attacker controls that
// resolves to 127.0.0.1 is genuinely same-origin with the daemon, so Origin and
// Sec-Fetch-Site both say "fine" and every other layer passes. The Host header
// still names the attacker, which is what catches it.
//
// The request is browser-shaped on purpose: that is the only way a rebinding
// attack can reach a loopback listener, and the Host check is scoped to
// browser-shaped requests so a non-browser client addressing the daemon by
// another name (a test harness, a tunnel) is not refused.
func TestCSRFRebindingHostRefused(t *testing.T) {
	for _, hdr := range []map[string]string{
		{"Content-Type": "application/json", "Origin": "http://rebind.evil.example:4173"},
		{"Content-Type": "application/json", "Sec-Fetch-Site": "same-origin"},
	} {
		req := httptest.NewRequest(http.MethodPost, "http://rebind.evil.example:4173/v1/agents", strings.NewReader("{}"))
		req.Host = "rebind.evil.example:4173"
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		if reason := checkOrigin(req); reason == "" {
			t.Errorf("a rebound Host was accepted with %v; DNS-rebinding layer is not working", hdr)
		}
	}
	// A non-browser client addressing the daemon by another name is fine: no
	// Origin, no fetch metadata, nothing to rebind.
	req := httptest.NewRequest(http.MethodPost, "http://caprock.internal:4173/v1/agents", strings.NewReader("{}"))
	req.Host = "caprock.internal:4173"
	req.Header.Set("Content-Type", "application/json")
	if reason := checkOrigin(req); reason != "" {
		t.Errorf("non-browser client refused by the Host check: %q", reason)
	}
}
