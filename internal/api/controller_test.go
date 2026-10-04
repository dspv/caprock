package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/pairing"
	"github.com/dspv/caprock/internal/store"
)

// The LAN address the tests' daemon answers on, and a phone on that network.
const (
	testLANURL = "http://192.168.1.10:4173"
	testPhone  = "192.168.1.50:51000"
)

// What a viewer may do, written out here rather than read from
// pairedDeviceRoutes, so a route added to that map without a decision shows
// up as a failing test rather than a quietly wider door.
var viewerMay = map[string]bool{
	"GET /v1/sessions": true, "GET /v1/sessions/{id}": true, "GET /v1/sessions/{id}/events": true,
	"GET /v1/sessions/{id}/notes": true, "GET /v1/sessions/{id}/diff": true, "GET /v1/notes": true,
	"GET /v1/stats/summary": true, "GET /v1/stats/daily": true, "GET /v1/events": true,
	"GET /v1/history": true, "GET /v1/status": true, "GET /v1/storage": true, "GET /v1/update": true,
	"GET /v1/settings": true, "GET /v1/premium": true, "GET /v1/gemini": true, "GET /v1/pricing": true,
	"GET /v1/live": true, "GET /v1/tasks": true, "GET /v1/tasks/{id}": true, "GET /v1/approvals": true,
	"GET /v1/statusline/{id}": true, "GET /v1/pair/me": true, "GET /healthz": true,
}

// What a controller may do on top (ADR-034): work on a session, nothing about
// the machine.
var controllerMayAlso = map[string]bool{
	"POST /v1/agents": true, "GET /v1/agents/models": true, "GET /v1/recent-dirs": true,
	"GET /v1/sessions/{id}/relay": true, "GET /v1/agents/{id}/term": true,
	"POST /v1/agents/{id}/input": true, "POST /v1/agents/{id}/signal": true, "POST /v1/paste": true,
	"POST /v1/tasks/{id}/approve": true, "POST /v1/tasks/{id}/reject": true,
}

// registeredRoutes reads every route New registers out of api.go, so a route
// added next month is in this test without anyone remembering to add it.
func registeredRoutes(t *testing.T) []string {
	t.Helper()
	src, err := os.ReadFile("api.go")
	if err != nil {
		t.Fatal(err)
	}
	re := regexp.MustCompile(`m\.Handle(?:Func)?\("([A-Z]+ /[^"]*)"`)
	var out []string
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		out = append(out, m[1])
	}
	if len(out) < 50 {
		t.Fatalf("found only %d routes in api.go; the pattern no longer matches how routes are registered", len(out))
	}
	return out
}

// phoneRequest is a request for pattern from a device on the network.
func phoneRequest(pattern, token string) *http.Request {
	method, path, _ := strings.Cut(pattern, " ")
	path = strings.NewReplacer("{id}", "abc").Replace(path)
	r := httptest.NewRequest(method, path, nil)
	r.RemoteAddr = testPhone
	if token != "" {
		r.Header.Set(deviceTokenHeader, token)
	}
	return r
}

// pairedPhones is a daemon with network access on and two paired phones: one
// left a viewer, one the owner made a controller.
func pairedPhones(t *testing.T, d Deps) (s *Server, ps *pairing.Store, viewer, controller *pairing.Device) {
	t.Helper()
	ps = pairing.New()
	d.Pairing, d.LANURL = ps, testLANURL
	s = New(d)
	redeem := func(name string) *pairing.Device {
		code, err := ps.NewCode()
		if err != nil {
			t.Fatal(err)
		}
		dev, err := ps.Redeem(code, name)
		if err != nil {
			t.Fatal(err)
		}
		return dev
	}
	viewer, controller = redeem("viewer phone"), redeem("controller phone")
	if !ps.SetRole(controller.ID, pairing.RoleController) {
		t.Fatal("could not make the controller")
	}
	return s, ps, viewer, controller
}

// Every endpoint, for all three callers: the machine itself, a phone that
// views, and a phone that controls. A view-only phone gets 403 on every
// mutating endpoint, whatever it is.
func TestEveryEndpointForEveryRole(t *testing.T) {
	s, _, viewer, controller := pairedPhones(t, Deps{})
	for _, pattern := range registeredRoutes(t) {
		method, _, _ := strings.Cut(pattern, " ")
		t.Run(pattern, func(t *testing.T) {
			local := phoneRequest(pattern, "")
			local.RemoteAddr = "127.0.0.1:51000"
			if got, why := s.gate(local); got != 0 {
				t.Errorf("the machine itself: %d (%s)", got, why)
			}

			// The pairing endpoint is open to every device, paired or not; it
			// only exchanges a code for a token.
			open := pattern == "POST /v1/pair"
			wantViewer := 0
			if !viewerMay[pattern] && !open {
				wantViewer = http.StatusForbidden
			}
			if method != http.MethodGet && wantViewer == 0 && !open {
				t.Fatalf("test table lets a viewer make a %s", method)
			}
			if got, why := s.gate(phoneRequest(pattern, viewer.Token)); got != wantViewer {
				t.Errorf("viewer: %d, want %d (%s)", got, wantViewer, why)
			}

			wantController := 0
			if !viewerMay[pattern] && !controllerMayAlso[pattern] && !open {
				wantController = http.StatusForbidden
			}
			if got, why := s.gate(phoneRequest(pattern, controller.Token)); got != wantController {
				t.Errorf("controller: %d, want %d (%s)", got, wantController, why)
			}

			// And without a token, nothing but the pairing endpoint.
			if pattern != "POST /v1/pair" && pattern != "GET /healthz" {
				if got, _ := s.gate(phoneRequest(pattern, "")); got != http.StatusUnauthorized {
					t.Errorf("unpaired: %d, want 401", got)
				}
			}
		})
	}
	// Every route the tables name exists: a typo there would pass forever.
	have := map[string]bool{}
	for _, p := range registeredRoutes(t) {
		have[p] = true
	}
	for _, table := range []map[string]bool{viewerMay, controllerMayAlso} {
		for p := range table {
			if !have[p] {
				t.Errorf("the test names %q, which api.go does not register", p)
			}
		}
	}
}

// A viewer's 403 says where control is granted; a controller's says this one
// is done on the machine. Both through the real handler chain.
func TestRefusalsSayWhatToDo(t *testing.T) {
	s, _, viewer, controller := pairedPhones(t, Deps{})
	for _, tc := range []struct {
		pattern, token, want string
	}{
		{"POST /v1/agents/{id}/input", viewer.Token, viewerRefusal},
		{"PUT /v1/settings", controller.Token, controllerRefusal},
		{"POST /v1/pair/code", controller.Token, controllerRefusal},
	} {
		r := phoneRequest(tc.pattern, tc.token)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		var body map[string]string
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		if w.Code != http.StatusForbidden || body["error"] != tc.want || body["detail"] == "" {
			t.Errorf("%s: %d %q", tc.pattern, w.Code, w.Body)
		}
	}
}

// Taking control away is the next request, not the next restart.
func TestTakingControlAwayIsImmediate(t *testing.T) {
	s, ps, _, controller := pairedPhones(t, Deps{})
	r := phoneRequest("POST /v1/agents/{id}/signal", controller.Token)
	if got, _ := s.gate(r); got != 0 {
		t.Fatalf("controller refused: %d", got)
	}
	ps.SetRole(controller.ID, pairing.RoleViewer)
	if got, _ := s.gate(r); got != http.StatusForbidden {
		t.Fatalf("after control was taken away: %d, want 403", got)
	}
}

func TestPairMeNamesTheRole(t *testing.T) {
	s, _, viewer, controller := pairedPhones(t, Deps{})
	for _, tc := range []struct {
		from, token, want string
	}{
		{"127.0.0.1:51000", "", "owner"},
		{testPhone, viewer.Token, pairing.RoleViewer},
		{testPhone, controller.Token, pairing.RoleController},
	} {
		r := httptest.NewRequest(http.MethodGet, "/v1/pair/me", nil)
		r.RemoteAddr = tc.from
		if tc.token != "" {
			r.Header.Set(deviceTokenHeader, tc.token)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		var me pairMe
		if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil || w.Code != 200 || me.Role != tc.want {
			t.Errorf("from %s: %d %s, want role %s", tc.from, w.Code, w.Body, tc.want)
		}
	}
}

// Only the machine sets a role. A controller cannot promote anyone, itself
// included.
func TestOnlyTheMachineSetsARole(t *testing.T) {
	s, ps, viewer, controller := pairedPhones(t, Deps{})
	put := func(from, token, id, body string) int {
		r := httptest.NewRequest(http.MethodPut, "/v1/pair/devices/"+id+"/role", strings.NewReader(body))
		r.RemoteAddr = from
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set(deviceTokenHeader, token)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w.Code
	}
	promote := `{"role":"controller"}`
	if got := put(testPhone, controller.Token, viewer.ID, promote); got != http.StatusForbidden {
		t.Errorf("controller promoted a viewer: %d", got)
	}
	if got := put(testPhone, viewer.Token, viewer.ID, promote); got != http.StatusForbidden {
		t.Errorf("viewer promoted itself: %d", got)
	}
	if ps.RoleOf(viewer.Token) != pairing.RoleViewer {
		t.Fatal("a phone changed a role")
	}
	if got := put("127.0.0.1:51000", "", viewer.ID, promote); got != http.StatusOK {
		t.Fatalf("the machine could not promote: %d", got)
	}
	if ps.RoleOf(viewer.Token) != pairing.RoleController {
		t.Fatal("promotion did not take")
	}
	if got := put("127.0.0.1:51000", "", viewer.ID, `{"role":"owner"}`); got != http.StatusBadRequest {
		t.Errorf("an unknown role: %d, want 400", got)
	}
	if got := put("127.0.0.1:51000", "", "nobody", promote); got != http.StatusNotFound {
		t.Errorf("an unknown device: %d, want 404", got)
	}
}

// With network access off the role is set in the saved guest list, and holds
// when access is turned on again.
func TestSetRoleWhileNetworkAccessIsOff(t *testing.T) {
	dir := t.TempDir()
	ps := pairing.New()
	code, _ := ps.NewCode()
	dev, _ := ps.Redeem(code, "phone")
	if err := config.WriteDevices(dir, ps.Snapshot()); err != nil {
		t.Fatal(err)
	}
	s := New(Deps{DataDir: dir}) // LAN off
	r := httptest.NewRequest(http.MethodPut, "/v1/pair/devices/"+dev.ID+"/role", strings.NewReader(`{"role":"controller"}`))
	r.RemoteAddr = "127.0.0.1:51000"
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	saved, _ := config.ReadDevices(dir)
	again := pairing.New()
	again.Load(saved)
	if again.RoleOf(dev.Token) != pairing.RoleController {
		t.Fatal("the role was not saved")
	}
}

// A controller starts a known agent in a known project, and nothing else.
// The machine itself is not narrowed.
func TestAControllerStartsAgentsOnlyInKnownProjects(t *testing.T) {
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	known := t.TempDir()
	if err := store.UpsertSession(context.Background(), st.DB(), "s1", store.SessionPatch{Cwd: known}); err != nil {
		t.Fatal(err)
	}
	fa := &fakeAgents{avail: true}
	s, _, viewer, controller := pairedPhones(t, Deps{Store: st, Agents: fa})
	spawn := func(from, token, body string) int {
		r := httptest.NewRequest(http.MethodPost, "/v1/agents", bytes.NewBufferString(body))
		r.RemoteAddr = from
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set(deviceTokenHeader, token)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w.Code
	}
	unknown := t.TempDir()
	for _, tc := range []struct {
		name, from, token, body string
		want                    int
	}{
		{"controller, known project", testPhone, controller.Token, `{"cwd":"` + known + `","agent":"codex"}`, 200},
		{"controller, resume in a known project", testPhone, controller.Token, `{"cwd":"` + known + `","resume":"a-session-run-elsewhere"}`, 200},
		{"controller, false flags ask for nothing", testPhone, controller.Token, `{"cwd":"` + known + `","create":false,"args":[]}`, 200},
		{"controller, unknown folder", testPhone, controller.Token, `{"cwd":"` + unknown + `"}`, 403},
		{"controller, relative path", testPhone, controller.Token, `{"cwd":"dev/x"}`, 403},
		{"controller, any binary", testPhone, controller.Token, `{"cwd":"` + known + `","command":"sh"}`, 403},
		{"controller, any flags", testPhone, controller.Token, `{"cwd":"` + known + `","args":["--x"]}`, 403},
		{"controller, a new folder", testPhone, controller.Token, `{"cwd":"` + known + `/new","create":true}`, 403},
		{"controller, a scratch chat", testPhone, controller.Token, `{"chat":true}`, 403},
		{"controller, bypass mode", testPhone, controller.Token, `{"cwd":"` + known + `","permission_mode":"bypassPermissions"}`, 403},
		{"controller, codex in bypass mode", testPhone, controller.Token, `{"cwd":"` + known + `","agent":"codex","permission_mode":"bypassPermissions"}`, 403},
		{"controller, a mode that asks", testPhone, controller.Token, `{"cwd":"` + known + `","permission_mode":"acceptEdits"}`, 200},
		{"controller, plan mode", testPhone, controller.Token, `{"cwd":"` + known + `","permission_mode":"plan"}`, 200},
		{"viewer, known project", testPhone, viewer.Token, `{"cwd":"` + known + `"}`, 403},
		{"the machine, any folder", "127.0.0.1:51000", "", `{"cwd":"` + unknown + `","command":"sh"}`, 200},
		{"the machine, bypass mode", "127.0.0.1:51000", "", `{"cwd":"` + known + `","permission_mode":"bypassPermissions"}`, 200},
	} {
		if got := spawn(tc.from, tc.token, tc.body); got != tc.want {
			t.Errorf("%s: %d, want %d", tc.name, got, tc.want)
		}
	}
}

// The terminal over the network: a controller's phone opens it at the LAN
// address with its token as a subprotocol, types, and stops being able to the
// moment control is taken away — on the socket already open.
func TestAControllerTypesUntilControlIsTakenAway(t *testing.T) {
	fa := &fakeAgents{avail: true, snapshot: []byte("SNAP"), termCh: make(chan []byte, 4)}
	s, ps, viewer, controller := pairedPhones(t, Deps{Agents: fa})
	// Every request arrives as if from the phone.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.RemoteAddr = testPhone
		s.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/agents/s1/term"
	dial := func(tok string) (*websocket.Conn, error) {
		c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
			HTTPHeader:   http.Header{"Origin": {testLANURL}},
			Subprotocols: []string{"caprock.device." + tok},
		})
		return c, err
	}

	if c, err := dial(viewer.Token); err == nil {
		_ = c.CloseNow()
		t.Fatal("a viewer opened the terminal")
	}

	c, err := dial(controller.Token)
	if err != nil {
		t.Fatalf("the controller could not open the terminal: %v", err)
	}
	defer func() { _ = c.CloseNow() }()
	if _, snap, err := c.Read(ctx); err != nil || string(snap) != "SNAP" {
		t.Fatalf("snapshot: %v %q", err, snap)
	}
	if err := c.Write(ctx, websocket.MessageBinary, []byte("ls\r")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(fa.wrote()) == 1 })

	ps.SetRole(controller.ID, pairing.RoleViewer)
	_ = c.Write(ctx, websocket.MessageBinary, []byte("rm -rf x\r"))
	_, _, err = c.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("socket after demotion: %v, want a policy-violation close", err)
	}
	if w := fa.wrote(); len(w) != 1 || w[0] != "ls\r" {
		t.Fatalf("keystrokes after demotion reached the session: %q", w)
	}
}

// A browser on the Mac that opened the network address pairs like a phone; the
// list must say it is this computer rather than show a stray "Mac".
func TestPairingFromThisMachinesOwnAddressSaysSo(t *testing.T) {
	ps := pairing.New()
	s := New(Deps{Pairing: ps, LANURL: testLANURL})
	redeem := func(from, name string) string {
		code, _ := ps.NewCode()
		r := httptest.NewRequest(http.MethodPost, "/v1/pair", strings.NewReader(`{"code":"`+code+`","name":"`+name+`"}`))
		r.RemoteAddr = from
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		var out pairResponse
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 {
			t.Fatalf("pair from %s: %d %s", from, w.Code, w.Body)
		}
		return out.Name
	}
	if got := redeem("192.168.1.10:50000", "Mac · Chrome"); got != "This computer · Mac · Chrome" {
		t.Errorf("from the machine's own address: %q", got)
	}
	if got := redeem(testPhone, "iPhone · Safari"); got != "iPhone · Safari" {
		t.Errorf("from a phone: %q", got)
	}
}
