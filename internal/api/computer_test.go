package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/pairing"
	"github.com/dspv/caprock/internal/store"
)

// What a computer may do on top of a controller (ADR-067), written out here
// rather than read from computerRoutes, so a route added to that map without
// a decision shows up as a failing test.
var computerMayAlso = map[string]bool{
	"POST /v1/shells": true, "GET /v1/shells": true,
	"GET /v1/hive/starter": true, "POST /v1/hive": true, "POST /v1/tasks": true, "POST /v1/tasks/{id}/verify": true,
	"POST /v1/orchestrator/start": true, "POST /v1/orchestrator/stop": true,
	"GET /v1/agents/custom": true, "GET /v1/activity": true, "GET /v1/overlap": true, "GET /v1/update/busy": true,
	"GET /v1/github/actions-usage": true, "GET /v1/github/statuspage": true,
	"GET /v1/sessions/{id}/prs": true, "POST /v1/sessions/{id}/prs/{number}/rerun": true,
	"POST /v1/sessions/{id}/prs/{number}/update-branch": true, "GET /v1/sessions/{id}/ci": true,
	"GET /v1/sessions/{id}/branches": true, "GET /v1/sessions/{id}/ci/jobs/{job}/log": true,
	"GET /v1/sessions/{id}/ci/release": true, "GET /v1/sessions/{id}/ci/main": true, "GET /v1/sessions/{id}/ci/stats": true,
	"GET /v1/sessions/{id}/ci/costliest": true,
	"GET /v1/projects/{id}/branches":     true, "GET /v1/projects/{id}/copies": true, "POST /v1/projects/{id}/copies/remove": true,
	"GET /v1/projects/{id}/cleanup": true, "POST /v1/projects/{id}/cleanup": true, "POST /v1/projects/{id}/cleanup/restore": true,
	"GET /v1/projects/scan": true, "POST /v1/projects/merge": true, "POST /v1/projects/{id}/split": true,
}

// What stays the machine's own whatever the device (ADR-067): named, so a
// widening of computerRoutes over one of these fails here by name.
var neverAComputer = []string{
	"PUT /v1/settings", "POST /v1/pair/code", "DELETE /v1/pair/code", "DELETE /v1/pair/devices/{id}",
	"PUT /v1/pair/devices/{id}/role", "POST /v1/pair/devices/{id}/allow", "POST /v1/pair/lan", "POST /v1/pair/remote",
	"GET /v1/pair/state", "POST /v1/footprint/orphans/stop", "POST /v1/resources/reap", "POST /v1/system/memory/end-idle", "POST /v1/system/memory/restart", "POST /v1/shutdown",
	"POST /v1/update/check", "POST /v1/hooks/install", "POST /v1/sessions/{id}/open-terminal", "GET /v1/editors",
	"POST /v1/editors/open", "PUT /v1/telegram/token", "POST /v1/github/connect", "PUT /v1/agents/custom",
	"POST /v1/subscriptions", "GET /v1/machines", "GET /v1/machines/sessions", "POST /v1/machines", "PATCH /v1/machines/{id}", "DELETE /v1/machines/{id}",
}

// pairedComputer adds to ps a computer that redeemed a code for one and,
// when allow is set, was allowed by the owner.
func pairedComputer(t *testing.T, ps *pairing.Store, name string, allow bool) *pairing.Device {
	t.Helper()
	code, err := ps.NewCodeFor(pairing.RoleViewer, pairing.KindMachine)
	if err != nil {
		t.Fatal(err)
	}
	dev, err := ps.Redeem(code, name)
	if err != nil {
		t.Fatal(err)
	}
	if allow && !ps.Allow(dev.ID) {
		t.Fatal("could not allow the computer")
	}
	return dev
}

// Every endpoint, for a computer the owner allowed and for one still waiting.
func TestEveryEndpointForAComputer(t *testing.T) {
	s, ps, _, _ := pairedPhones(t, Deps{})
	allowed := pairedComputer(t, ps, "MacBook", true)
	waiting := pairedComputer(t, ps, "Stranger", false)
	have := map[string]bool{}
	for _, pattern := range registeredRoutes(t) {
		have[pattern] = true
		t.Run(pattern, func(t *testing.T) {
			open := pattern == "POST /v1/pair" || pattern == "DELETE /v1/pair/me"
			want := http.StatusForbidden
			if open || viewerMay[pattern] || controllerMayAlso[pattern] || computerMayAlso[pattern] {
				want = 0
			}
			if got, why := s.gate(phoneRequest(pattern, allowed.Token)); got != want {
				t.Errorf("computer: %d, want %d (%s)", got, want, why)
			}
			// Waiting: nothing but where it stands, and withdrawing — and
			// the dashboard's own files, open even before pairing (a private
			// module's pages are not those: ADR-076).
			want = http.StatusForbidden
			if open || pattern == "GET /v1/pair/me" || (!strings.Contains(pattern, " /v1/") && !strings.Contains(pattern, " /x/")) {
				want = 0
			}
			if got, why := s.gate(phoneRequest(pattern, waiting.Token)); got != want {
				t.Errorf("waiting computer: %d, want %d (%s)", got, want, why)
			}
		})
	}
	for p := range computerMayAlso {
		if !have[p] {
			t.Errorf("the test names %q, which api.go does not register", p)
		}
		if !computerRoutes[p] {
			t.Errorf("%q is in the test's table but not in computerRoutes", p)
		}
	}
	for _, p := range neverAComputer {
		if !have[p] {
			t.Errorf("the test names %q, which api.go does not register", p)
		}
		if got, _ := s.gate(phoneRequest(p, allowed.Token)); got != http.StatusForbidden {
			t.Errorf("a computer reached %s: %d", p, got)
		}
	}
	// The other computers' proxy is this machine's only: not transitive.
	for _, tok := range []string{allowed.Token, waiting.Token} {
		r := httptest.NewRequest(http.MethodGet, "/v1/m/abc/v1/sessions", nil)
		r.RemoteAddr = testPhone
		r.Header.Set(deviceTokenHeader, tok)
		if got, _ := s.gate(r); got != http.StatusForbidden {
			t.Errorf("a device reached the proxy: %d", got)
		}
	}
}

// local is a request from a client on this machine.
func local(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:51000"
	r.Host = "127.0.0.1:22776"
	r.Header.Set("Content-Type", "application/json")
	return r
}

// fromDevice is a request from a device holding token.
func fromDevice(method, path, body, token string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = testPhone
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set(deviceTokenHeader, token)
	return r
}

func serve(s *Server, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

// The whole pairing of a computer on the target: a code for a computer turns
// access from anywhere on, the computer redeems it and waits, reads only
// where it stands, is allowed by name from this machine alone, and can
// withdraw itself.
func TestAComputerPairsWaitsAndIsAllowed(t *testing.T) {
	ps := pairing.New()
	rem := &fakeRemote{}
	b := bus.New()
	s := New(Deps{Pairing: ps, LANURL: testLANURL, Remote: rem, Bus: b, DataDir: t.TempDir()})
	sub, _, _, _ := b.Resume(16, nil)
	defer sub.Unsubscribe()

	if w := serve(s, local("POST", "/v1/pair/code", `{"kind":"tablet"}`)); w.Code != 400 {
		t.Fatalf("an unknown kind: %d", w.Code)
	}
	w := serve(s, local("POST", "/v1/pair/code", `{"kind":"machine","role":"viewer"}`))
	var code struct {
		Code string `json:"code"`
		Role string `json:"role"`
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &code); err != nil || w.Code != 200 || code.Kind != "machine" || code.Role != "controller" {
		t.Fatalf("code for a computer: %d %s", w.Code, w.Body)
	}
	if !rem.on {
		t.Fatal("a code for a computer did not turn access from anywhere on")
	}
	var st pairState
	_ = json.Unmarshal(serve(s, local("GET", "/v1/pair/state", "")).Body.Bytes(), &st)
	if st.CodeKind != "machine" || st.CodeRole != "controller" {
		t.Fatalf("state names the code as %q %q", st.CodeKind, st.CodeRole)
	}

	// The computer says nothing about what it is; the code does.
	rd := httptest.NewRequest("POST", "/v1/pair", strings.NewReader(`{"code":"`+code.Code+`","name":"MacBook","kind":"phone"}`))
	rd.RemoteAddr = testPhone
	rd.Header.Set("Content-Type", "application/json")
	w = serve(s, rd)
	var tok pairResponse
	if err := json.Unmarshal(w.Body.Bytes(), &tok); err != nil || w.Code != 200 {
		t.Fatalf("redeem: %d %s", w.Code, w.Body)
	}
	select {
	case f := <-sub.C:
		if f.Type != bus.FrameDevices {
			t.Fatalf("frame %q", f.Type)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no devices frame after a computer paired")
	}
	_ = json.Unmarshal(serve(s, local("GET", "/v1/pair/state", "")).Body.Bytes(), &st)
	if len(st.Devices) != 1 || st.Devices[0].Kind != "machine" || !st.Devices[0].Pending {
		t.Fatalf("listed %+v", st.Devices)
	}

	// Waiting: where it stands, and nothing else.
	w = serve(s, fromDevice("GET", "/v1/pair/me", "", tok.Token))
	var me pairMe
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil || w.Code != 200 || !me.Pending || me.Kind != "machine" {
		t.Fatalf("pair/me while waiting: %d %s", w.Code, w.Body)
	}
	w = serve(s, fromDevice("GET", "/v1/sessions", "", tok.Token))
	if w.Code != 403 || !strings.Contains(w.Body.String(), pendingRefusal) {
		t.Fatalf("a waiting computer read sessions: %d %s", w.Code, w.Body)
	}

	// Allowed from this machine only — and never by the computer itself.
	if w := serve(s, fromDevice("POST", "/v1/pair/devices/"+tok.ID+"/allow", "", tok.Token)); w.Code != 403 {
		t.Fatalf("a computer allowed itself: %d", w.Code)
	}
	if w := serve(s, local("POST", "/v1/pair/devices/nobody/allow", "")); w.Code != 404 {
		t.Fatalf("allow an unknown id: %d", w.Code)
	}
	if w := serve(s, local("POST", "/v1/pair/devices/"+tok.ID+"/allow", "")); w.Code != 200 {
		t.Fatalf("allow: %d %s", w.Code, w.Body)
	}
	if got := ps.RoleOf(tok.Token); got != pairing.RoleController {
		t.Fatalf("after allow the role is %q", got)
	}
	saved, _ := config.ReadDevices(s.d.DataDir)
	if len(saved) != 1 || saved[0].Pending || saved[0].Kind != "machine" {
		t.Fatalf("saved %+v", saved)
	}
	w = serve(s, fromDevice("GET", "/v1/pair/me", "", tok.Token))
	var after pairMe
	_ = json.Unmarshal(w.Body.Bytes(), &after)
	if after.Pending || after.Role != "controller" {
		t.Fatalf("pair/me after allow: %s", w.Body)
	}

	// The machine itself is not a device to withdraw; the computer is.
	if w := serve(s, local("DELETE", "/v1/pair/me", "")); w.Code != 400 {
		t.Fatalf("the machine withdrew itself: %d", w.Code)
	}
	if w := serve(s, fromDevice("DELETE", "/v1/pair/me", "", tok.Token)); w.Code != 200 {
		t.Fatalf("withdraw: %d %s", w.Code, w.Body)
	}
	if w := serve(s, fromDevice("GET", "/v1/pair/me", "", tok.Token)); w.Code != 401 {
		t.Fatalf("after withdrawing: %d", w.Code)
	}
}

// Deny is Remove; with network access off, Allow edits the saved list.
func TestAllowWhileAccessIsOff(t *testing.T) {
	dir := t.TempDir()
	ps := pairing.New()
	dev := pairedComputer(t, ps, "MacBook", false)
	if err := config.WriteDevices(dir, ps.Snapshot()); err != nil {
		t.Fatal(err)
	}
	s := New(Deps{DataDir: dir})
	if w := serve(s, local("POST", "/v1/pair/devices/"+dev.ID+"/allow", "")); w.Code != 200 {
		t.Fatalf("allow while off: %d %s", w.Code, w.Body)
	}
	saved, _ := config.ReadDevices(dir)
	if len(saved) != 1 || saved[0].Pending || saved[0].Role != pairing.RoleController {
		t.Fatalf("saved %+v", saved)
	}
}

// A computer starts what the machine's own dashboard may: any folder, a
// command, a chat. A phone's limits stay a phone's.
func TestAComputerStartsAnything(t *testing.T) {
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	fakeHome(t)
	outside := filepath.ToSlash(t.TempDir())
	fa := &fakeAgents{avail: true}
	s, ps, _, controller := pairedPhones(t, Deps{Store: st, Agents: fa})
	comp := pairedComputer(t, ps, "MacBook", true)
	for _, tc := range []struct {
		name, token, body string
		want              int
	}{
		{"computer, a folder outside home", comp.Token, `{"cwd":"` + outside + `"}`, 200},
		{"computer, any binary", comp.Token, `{"cwd":"` + outside + `","command":"sh","args":["-c","true"]}`, 200},
		{"computer, a scratch chat", comp.Token, `{"chat":true}`, 200},
		{"phone controller, the same binary", controller.Token, `{"cwd":"` + outside + `","command":"sh"}`, 403},
	} {
		if w := serve(s, fromDevice("POST", "/v1/agents", tc.body, tc.token)); w.Code != tc.want {
			t.Errorf("%s: %d, want %d (%s)", tc.name, w.Code, tc.want, w.Body)
		}
	}
	_ = os.Remove(outside)
}

// Removing a device closes its open sockets at once with 1008 — /v1/live
// included, which used to stream on until the device reconnected — and so
// does a change of role.
func TestRemovingADeviceClosesItsSockets(t *testing.T) {
	b := bus.New()
	s, ps, viewer, _ := pairedPhones(t, Deps{Bus: b})
	comp := pairedComputer(t, ps, "MacBook", true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Test-Local") == "" {
			r.RemoteAddr = testPhone
		}
		s.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dial := func(tok string) *websocket.Conn {
		t.Helper()
		c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/v1/live", &websocket.DialOptions{
			HTTPHeader:   http.Header{"Origin": {testLANURL}},
			Subprotocols: []string{"caprock.device." + tok},
		})
		if err != nil {
			t.Fatalf("live: %v", err)
		}
		if _, _, err := c.Read(ctx); err != nil { // the hello
			t.Fatal(err)
		}
		return c
	}
	closed := func(c *websocket.Conn) websocket.StatusCode {
		t.Helper()
		for {
			if _, _, err := c.Read(ctx); err != nil {
				return websocket.CloseStatus(err)
			}
		}
	}
	cv, cc := dial(viewer.Token), dial(comp.Token)
	defer func() { _ = cv.CloseNow(); _ = cc.CloseNow() }()

	del := httptest.NewRequest("DELETE", "/v1/pair/devices/"+comp.ID, nil)
	del.RemoteAddr, del.Host = "127.0.0.1:51000", "127.0.0.1:22776"
	del.Header.Set("Content-Type", "application/json")
	if w := serve(s, del); w.Code != 200 {
		t.Fatalf("remove: %d %s", w.Code, w.Body)
	}
	if code := closed(cc); code != websocket.StatusPolicyViolation {
		t.Fatalf("the removed computer's live socket closed with %d, want 1008", code)
	}

	put := httptest.NewRequest("PUT", "/v1/pair/devices/"+viewer.ID+"/role", bytes.NewBufferString(`{"role":"controller"}`))
	put.RemoteAddr, put.Host = "127.0.0.1:51000", "127.0.0.1:22776"
	put.Header.Set("Content-Type", "application/json")
	if w := serve(s, put); w.Code != 200 {
		t.Fatalf("role: %d %s", w.Code, w.Body)
	}
	if code := closed(cv); code != websocket.StatusPolicyViolation {
		t.Fatalf("after a role change the live socket closed with %d, want 1008", code)
	}
}
