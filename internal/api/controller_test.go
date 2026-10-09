package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
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
	"GET /v1/sessions/{id}/subagents": true, // what the session's subagents are doing; the events already say it
	"GET /v1/sessions/{id}/calls":     true, // the priced model calls; the events already say them
	"GET /v1/stats/summary":           true, "GET /v1/stats/daily": true, "GET /v1/events": true,
	"GET /v1/history": true, "GET /v1/status": true, "GET /v1/storage": true, "GET /v1/update": true,
	"GET /v1/settings": true, "GET /v1/premium": true, "GET /v1/gemini": true, "GET /v1/pricing": true,
	"GET /v1/window-stop": true, "GET /v1/live": true, "GET /v1/tasks": true, "GET /v1/tasks/{id}": true, "GET /v1/approvals": true,
	"GET /v1/statusline/{id}": true, "GET /v1/pair/me": true, "GET /healthz": true,
	"GET /v1/agents/{id}/permission": true,
	"GET /v1/glance":                 true, "GET /v1/week": true, "GET /v1/tools/drill": true,
	"GET /v1/projects": true, "GET /v1/projects/ops": true, "GET /v1/projects/{id}/worktrees": true,
	"GET /v1/projects/{id}/changes": true, "GET /v1/projects/{id}/changes/diff": true,
	"GET /v1/projects/{id}/file": true, "GET /v1/projects/{id}/files": true,
	// GitHub (WP-19): the connection, the clone picker, pull requests.
	"GET /v1/github": true, "GET /v1/github/owners": true, "GET /v1/github/repos": true,
	"GET /v1/github/prs": true, "GET /v1/projects/{id}/github": true,
}

// What a controller may do on top (ADR-034): work on a session, nothing about
// the machine.
var controllerMayAlso = map[string]bool{
	"POST /v1/agents": true, "GET /v1/agents/models": true, "GET /v1/recent-dirs": true, "GET /v1/browse": true,
	"GET /v1/sessions/{id}/relay": true, "GET /v1/agents/{id}/term": true,
	"POST /v1/agents/{id}/input": true, "POST /v1/agents/{id}/signal": true, "POST /v1/paste": true,
	"POST /v1/agents/{id}/permission": true,
	"POST /v1/tasks/{id}/approve":     true, "POST /v1/tasks/{id}/reject": true,
	// Start work from the phone (21-app.md decision 8). Shells are not
	// here: from the phone they are P1, so POST and GET /v1/shells are 403.
	"POST /v1/projects": true, "PATCH /v1/projects/{id}": true, "DELETE /v1/projects/{id}": true,
	"POST /v1/projects/{id}/worktrees": true, "DELETE /v1/projects/{id}/worktrees/{name}": true,
	// Finish the work: stage, discard, commit, push, pull, fetch (ADR-034
	// amended 2026-10-06).
	"POST /v1/projects/{id}/changes/stage": true, "POST /v1/projects/{id}/changes/unstage": true,
	"POST /v1/projects/{id}/changes/discard": true, "POST /v1/projects/{id}/changes/commit": true,
	"POST /v1/projects/{id}/changes/push": true, "POST /v1/projects/{id}/changes/pull": true,
	"POST /v1/projects/{id}/changes/fetch": true,
	// Open a pull request, and read its state again now (WP-19).
	"POST /v1/projects/{id}/github/pr": true, "POST /v1/projects/{id}/github/refresh": true,
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
			local.Host = "127.0.0.1:22776"
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
		{"POST /v1/agents/{id}/permission", viewer.Token, viewerRefusal},
		{"POST /v1/paste", viewer.Token, viewerRefusal},
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
		r.Host = "127.0.0.1:22776" // what a client on the machine sends
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
		r.Host = "127.0.0.1:22776" // what a client on the machine sends
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
	r.Host = "127.0.0.1:22776"
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

// fakeHome points the home directory at a fresh folder, on every platform
// (Windows reads USERPROFILE, not HOME), and returns it.
func fakeHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	return home
}

// A controller starts a known agent, in any mode, in a folder under home, and
// nothing else — not even a project outside home where sessions have run. The
// machine itself is not narrowed.
func TestAControllerStartsAgentsUnderHome(t *testing.T) {
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	home := fakeHome(t)
	known := t.TempDir() // sessions have run there, but it is outside home
	if err := store.UpsertSession(context.Background(), st.DB(), "s1", store.SessionPatch{Cwd: known}); err != nil {
		t.Fatal(err)
	}
	fresh := filepath.Join(home, "dev", "fresh")
	if err := os.MkdirAll(fresh, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	escape := filepath.Join(home, "escape")
	hasSymlink := os.Symlink(outside, escape) == nil
	fa := &fakeAgents{avail: true}
	s, _, viewer, controller := pairedPhones(t, Deps{Store: st, Agents: fa})
	spawn := func(from, token, body string) int {
		r := httptest.NewRequest(http.MethodPost, "/v1/agents", bytes.NewBufferString(body))
		r.RemoteAddr = from
		r.Host = "127.0.0.1:22776" // what a client on the machine sends
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set(deviceTokenHeader, token)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w.Code
	}
	// Forward slashes keep a Windows path valid inside the JSON bodies below;
	// the handler's filepath.Clean turns them back.
	known, outside, fresh = filepath.ToSlash(known), filepath.ToSlash(outside), filepath.ToSlash(fresh)
	homeSlash, escapeSlash := filepath.ToSlash(home), filepath.ToSlash(escape)
	cases := []struct {
		name, from, token, body string
		want                    int
	}{
		{"controller, codex under home", testPhone, controller.Token, `{"cwd":"` + fresh + `","agent":"codex"}`, 200},
		{"controller, resume under home", testPhone, controller.Token, `{"cwd":"` + fresh + `","resume":"a-session-run-elsewhere"}`, 200},
		{"controller, false flags ask for nothing", testPhone, controller.Token, `{"cwd":"` + fresh + `","create":false,"args":[]}`, 200},
		{"controller, a known project outside home", testPhone, controller.Token, `{"cwd":"` + known + `"}`, 403},
		{"controller, a fresh folder under home", testPhone, controller.Token, `{"cwd":"` + fresh + `"}`, 200},
		{"controller, home itself", testPhone, controller.Token, `{"cwd":"` + homeSlash + `"}`, 200},
		{"controller, a new folder under home", testPhone, controller.Token, `{"cwd":"` + fresh + `/new","create":true}`, 200},
		{"controller, a missing folder without create", testPhone, controller.Token, `{"cwd":"` + fresh + `/missing"}`, 403},
		{"controller, two new levels under home", testPhone, controller.Token, `{"cwd":"` + fresh + `/a/b","create":true}`, 403},
		{"controller, a folder outside home", testPhone, controller.Token, `{"cwd":"` + outside + `"}`, 403},
		{"controller, a new folder outside home", testPhone, controller.Token, `{"cwd":"` + outside + `/new","create":true}`, 403},
		{"controller, dot-dot out of home", testPhone, controller.Token, `{"cwd":"` + homeSlash + `/../x"}`, 403},
		{"controller, relative path", testPhone, controller.Token, `{"cwd":"dev/x"}`, 403},
		{"controller, any binary", testPhone, controller.Token, `{"cwd":"` + fresh + `","command":"sh"}`, 403},
		{"controller, any flags", testPhone, controller.Token, `{"cwd":"` + fresh + `","args":["--x"]}`, 403},
		{"controller, a scratch chat", testPhone, controller.Token, `{"chat":true}`, 403},
		{"controller, bypass mode", testPhone, controller.Token, `{"cwd":"` + fresh + `","permission_mode":"bypassPermissions"}`, 200},
		{"controller, codex in bypass mode", testPhone, controller.Token, `{"cwd":"` + fresh + `","agent":"codex","permission_mode":"bypassPermissions"}`, 200},
		{"controller, plan mode", testPhone, controller.Token, `{"cwd":"` + fresh + `","permission_mode":"plan"}`, 200},
		{"viewer, a folder under home", testPhone, viewer.Token, `{"cwd":"` + fresh + `"}`, 403},
		{"the machine, any folder", "127.0.0.1:51000", "", `{"cwd":"` + outside + `","command":"sh"}`, 200},
		{"the machine, bypass mode", "127.0.0.1:51000", "", `{"cwd":"` + known + `","permission_mode":"bypassPermissions"}`, 200},
	}
	if hasSymlink {
		cases = append(cases,
			struct {
				name, from, token, body string
				want                    int
			}{"controller, a symlink out of home", testPhone, controller.Token, `{"cwd":"` + escapeSlash + `"}`, 403},
			struct {
				name, from, token, body string
				want                    int
			}{"controller, a new folder through a symlink out of home", testPhone, controller.Token, `{"cwd":"` + escapeSlash + `/new","create":true}`, 403},
		)
	} else {
		t.Log("symlinks unavailable here; the escape cases are skipped")
	}
	for _, tc := range cases {
		if got := spawn(tc.from, tc.token, tc.body); got != tc.want {
			t.Errorf("%s: %d, want %d", tc.name, got, tc.want)
		}
	}
}

// A controller's folder picker lists home and below, never above it and never
// through a symlink out of it; a viewer has no picker.
func TestAControllerBrowsesOnlyUnderHome(t *testing.T) {
	home := fakeHome(t)
	if err := os.MkdirAll(filepath.Join(home, "dev", "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	hasSymlink := os.Symlink(outside, filepath.Join(home, "escape")) == nil
	// The owner's own browse root is the filesystem: the phone still stops at home.
	set := &fakeSettings{}
	if err := set.Set(Settings{BrowseRoot: filepath.Dir(home)}); err != nil {
		t.Fatal(err)
	}
	s, _, viewer, controller := pairedPhones(t, Deps{Settings: set})
	browse := func(token, dir string) (int, browseResponse) {
		r := httptest.NewRequest(http.MethodGet, "/v1/browse?dir="+url.QueryEscape(dir), nil)
		r.RemoteAddr = testPhone
		r.Header.Set(deviceTokenHeader, token)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		var out browseResponse
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	realHome, _ := filepath.EvalSymlinks(home)
	if code, out := browse(controller.Token, ""); code != 200 || out.Root != realHome || out.Parent != "" {
		t.Errorf("controller at the root: %d root=%q parent=%q, want home %q", code, out.Root, out.Parent, realHome)
	}
	if code, _ := browse(controller.Token, filepath.Join(home, "dev")); code != 200 {
		t.Errorf("controller under home: %d", code)
	}
	if code, _ := browse(controller.Token, filepath.Dir(home)); code != 404 {
		t.Errorf("controller above home: %d, want 404", code)
	}
	if code, _ := browse(controller.Token, outside); code != 404 {
		t.Errorf("controller outside home: %d, want 404", code)
	}
	if hasSymlink {
		if code, _ := browse(controller.Token, filepath.Join(home, "escape")); code != 404 {
			t.Errorf("controller through a symlink out of home: %d, want 404", code)
		}
		_, out := browse(controller.Token, "")
		for _, e := range out.Entries {
			if e.Name == "escape" {
				t.Error("a controller was shown a symlink out of home")
			}
		}
	}
	if code, _ := browse(viewer.Token, ""); code != 403 {
		t.Errorf("viewer: %d, want 403", code)
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
		r.Host = "127.0.0.1:22776" // what a client on the machine sends
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

// A phone's Recent list holds only folders under home: anything else would be
// refused when picked. The machine's list is unchanged.
func TestAControllersRecentFoldersAreUnderHome(t *testing.T) {
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	home := fakeHome(t)
	inside, outside := filepath.Join(home, "app"), t.TempDir()
	if err := os.Mkdir(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	for i, dir := range []string{inside, outside} {
		if err := store.UpsertSession(context.Background(), st.DB(), "s"+string(rune('1'+i)), store.SessionPatch{Cwd: dir}); err != nil {
			t.Fatal(err)
		}
	}
	s, _, _, controller := pairedPhones(t, Deps{Store: st})
	recent := func(from, token string) []recentDir {
		r := httptest.NewRequest(http.MethodGet, "/v1/recent-dirs", nil)
		r.RemoteAddr = from
		r.Host = "127.0.0.1:22776" // what a client on the machine sends
		if token != "" {
			r.Header.Set(deviceTokenHeader, token)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		var out []recentDir
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	if got := recent(testPhone, controller.Token); len(got) != 1 || got[0].Dir != inside {
		t.Errorf("controller: %+v, want only %s", got, inside)
	}
	if got := recent("127.0.0.1:51000", ""); len(got) != 2 {
		t.Errorf("the machine: %+v, want both", got)
	}
}
