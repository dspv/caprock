package api

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/modules"
	"github.com/dspv/caprock/internal/pairing"
	"github.com/dspv/caprock/internal/store"
)

type fakeAdmin struct{ key string }

func (f *fakeAdmin) AdminKey() string           { return f.key }
func (f *fakeAdmin) SetAdminKey(k string) error { f.key = k; return nil }

type moduleEnv struct {
	*env
	admin *fakeAdmin
	priv  ed25519.PrivateKey
	data  string
}

// newModuleEnv is a server with a data directory, an admin store and a key
// pair of the test's own in place of the one compiled into the build.
func newModuleEnv(t *testing.T, opts ...func(*Deps)) *moduleEnv {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	admin := &fakeAdmin{}
	data := t.TempDir()
	d := Deps{Store: st, Bus: bus.New(), Version: "test", Token: "tok", DataDir: data, Admin: admin,
		Now:         func() time.Time { return time.UnixMilli(1_000) },
		AdminVerify: func(k string) (modules.Grant, error) { return modules.ParseKeyWith(k, pub) },
	}
	for _, o := range opts {
		o(&d)
	}
	s := New(d)
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return &moduleEnv{env: &env{srv: srv, api: s, st: st}, admin: admin, priv: priv, data: data}
}

func (e *moduleEnv) key(mods string) string {
	body := base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"sub":"someone","role":"admin","modules":[` + mods + `],"iat":"2026-10-17"}`))
	return modules.KeyPrefix + body + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(e.priv, []byte(body)))
}

func (e *moduleEnv) install(t *testing.T, id, name string) {
	t.Helper()
	dir := filepath.Join(modules.Root(e.data), id)
	if err := os.MkdirAll(filepath.Join(dir, "js"), 0o700); err != nil {
		t.Fatal(err)
	}
	for f, b := range map[string]string{
		modules.ManifestFile: `{"id":"` + id + `","name":"` + name + `"}`,
		modules.Entry:        "<!doctype html><p>module " + id + "</p>",
		"js/app.js":          "export {}",
	} {
		if err := os.WriteFile(filepath.Join(dir, f), []byte(b), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func (e *moduleEnv) page(t *testing.T, path string) (int, string) {
	t.Helper()
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := c.Get(e.srv.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// Without a key, nothing about a module answers: no state, no page, no store.
func TestModulesInvisibleWithoutKey(t *testing.T) {
	e := newModuleEnv(t)
	e.install(t, "alpha", "Alpha")
	var st AdminState
	if code := e.get(t, "/v1/admin", &st); code != 200 || st.Admin || len(st.Installed) != 0 || st.KeyError != "" {
		t.Fatalf("GET /v1/admin = %d %+v", code, st)
	}
	if code, _ := e.page(t, "/x/alpha/"); code != 404 {
		t.Errorf("page without a key: %d", code)
	}
	if code := e.send(t, http.MethodPut, "/v1/x/alpha/docs/notes/a", `{"x":1}`, nil); code != 403 {
		t.Errorf("store write without a key: %d", code)
	}
	if code := e.get(t, "/v1/x/alpha/docs/notes", nil); code != 403 {
		t.Errorf("store list without a key: %d", code)
	}

	// A key that does not verify is refused and not stored.
	if code := e.send(t, http.MethodPut, "/v1/admin", `{"key":"CRA1.abc.def"}`, nil); code != 400 {
		t.Errorf("bad key: %d", code)
	}
	if e.admin.key != "" {
		t.Errorf("a bad key was stored: %q", e.admin.key)
	}
}

func TestModuleKeyPageAndStore(t *testing.T) {
	e := newModuleEnv(t)
	e.install(t, "alpha", "Alpha")
	e.install(t, "beta", "Beta") // installed, but the key does not name it

	var st AdminState
	if code := e.send(t, http.MethodPut, "/v1/admin", `{"key":"  `+e.key(`"alpha"`)+`\n"}`, &st); code != 200 {
		t.Fatalf("set key: %d", code)
	}
	if !st.Admin || st.Subject != "someone" || len(st.Installed) != 1 || st.Installed[0].ID != "alpha" || st.Installed[0].URL != "/x/alpha/" {
		t.Fatalf("state = %+v", st)
	}
	if strings.HasPrefix(e.admin.key, " ") {
		t.Error("the key was stored with its whitespace")
	}

	// Pages: the entry, a nested file, the bare id redirected; nothing else.
	if code, body := e.page(t, "/x/alpha/"); code != 200 || !strings.Contains(body, "module alpha") {
		t.Errorf("entry: %d %q", code, body)
	}
	if code, _ := e.page(t, "/x/alpha/js/app.js"); code != 200 {
		t.Errorf("nested file: %d", code)
	}
	if code, _ := e.page(t, "/x/alpha"); code != http.StatusMovedPermanently {
		t.Errorf("bare id: %d", code)
	}
	for _, p := range []string{"/x/beta/", "/x/gamma/", "/x/alpha/missing.js", "/x/alpha/js/"} {
		if code, _ := e.page(t, p); code != 404 {
			t.Errorf("%s: %d, want 404", p, code)
		}
	}

	// A path climbing out is cleaned by the router, and lands on a module the key does not name.
	resp, err := http.Get(e.srv.URL + "/x/alpha/../beta/index.html")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Errorf("climbing out: %d", resp.StatusCode)
	}

	// The store: set, get, update, list, delete.
	var d store.ModuleDoc
	if code := e.send(t, http.MethodPut, "/v1/x/alpha/docs/notes/a", `{"x":1,"y":2}`, &d); code != 200 || d.ID != "a" {
		t.Fatalf("set: %d %+v", code, d)
	}
	if code := e.send(t, http.MethodPatch, "/v1/x/alpha/docs/notes/a", `{"y":null,"z":"w"}`, &d); code != 200 || string(d.Data) != `{"x":1,"z":"w"}` {
		t.Fatalf("update: %d %s", code, d.Data)
	}
	if code := e.send(t, http.MethodPatch, "/v1/x/alpha/docs/notes/missing", `{}`, nil); code != 404 {
		t.Errorf("update of a missing doc: %d", code)
	}
	if code := e.get(t, "/v1/x/alpha/docs/notes/a", &d); code != 200 || string(d.Data) != `{"x":1,"z":"w"}` {
		t.Errorf("get: %d %s", code, d.Data)
	}
	var list struct {
		Docs []store.ModuleDoc `json:"docs"`
		Next string            `json:"next"`
	}
	_ = e.send(t, http.MethodPut, "/v1/x/alpha/docs/notes/b", `{}`, nil)
	if code := e.get(t, "/v1/x/alpha/docs/notes?limit=1", &list); code != 200 || len(list.Docs) != 1 || list.Next != "a" {
		t.Errorf("list: %d %+v", code, list)
	}
	for body, want := range map[string]int{`[1,2]`: 400, `"x"`: 400, `null`: 400, `{`: 400} {
		if code := e.send(t, http.MethodPut, "/v1/x/alpha/docs/notes/c", body, nil); code != want {
			t.Errorf("PUT %s: %d, want %d", body, code, want)
		}
	}
	if code := e.send(t, http.MethodPut, "/v1/x/alpha/docs/.hidden/c", `{}`, nil); code != 400 {
		t.Errorf("a collection starting with a dot: %d", code)
	}
	if code := e.send(t, http.MethodPut, "/v1/x/beta/docs/notes/a", `{}`, nil); code != 403 {
		t.Errorf("a module the key does not name: %d", code)
	}
	if code := e.send(t, http.MethodDelete, "/v1/x/alpha/docs/notes/a", ``, nil); code != 200 {
		t.Errorf("delete: %d", code)
	}
	if code := e.get(t, "/v1/x/alpha/docs/notes/a", nil); code != 404 {
		t.Errorf("get after delete: %d", code)
	}

	// Clearing the key closes everything again.
	if code := e.send(t, http.MethodDelete, "/v1/admin", ``, nil); code != 200 {
		t.Fatalf("clear: %d", code)
	}
	if code, _ := e.page(t, "/x/alpha/"); code != 404 {
		t.Errorf("page after clearing: %d", code)
	}
	if code := e.get(t, "/v1/x/alpha/docs/notes/b", nil); code != 403 {
		t.Errorf("store after clearing: %d", code)
	}
}

// A stored key that no longer verifies says why, to the one who stored it.
func TestStoredBadKeySaysWhy(t *testing.T) {
	e := newModuleEnv(t)
	e.admin.key = e.key(`"alpha"`) + "x"
	var st AdminState
	if code := e.get(t, "/v1/admin", &st); code != 200 || st.Admin || st.KeyError == "" {
		t.Fatalf("GET /v1/admin = %d %+v", code, st)
	}
}

// A request relayed onto loopback is not the machine's, so it gets no module:
// without a device token it is not paired at all (401), even with network
// access off.
func TestModulesRefuseForwarded(t *testing.T) {
	e := newModuleEnv(t)
	e.install(t, "alpha", "Alpha")
	e.admin.key = e.key(`"alpha"`)
	req, _ := http.NewRequest(http.MethodGet, e.srv.URL+"/x/alpha/", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Errorf("forwarded request: %d, want 401", resp.StatusCode)
	}
}

// A paired controller works in a keyed module as the machine does (ADR-076,
// amended 2026-10-21): the admin state without the key, the pages and the
// store, over the network listener and through the relay. A viewer gets
// nothing of it, a device without a token is 401, the key itself is set only
// on the machine, and loopback that looks relayed is a device, not the owner.
func TestModulesForAController(t *testing.T) {
	ps := pairing.New()
	e := newModuleEnv(t, func(d *Deps) { d.Pairing, d.LANURL = ps, testLANURL })
	e.install(t, "alpha", "Alpha")
	e.install(t, "beta", "Beta")           // installed, but the key does not name it
	e.admin.key = e.key(`"alpha","gamma"`) // gamma is named, but not installed
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
	viewer, controller := redeem("viewer phone"), redeem("controller phone")
	if !ps.SetRole(controller.ID, pairing.RoleController) {
		t.Fatal("could not make the controller")
	}

	// do sends one request as a device: over the LAN listener, or relayed
	// onto loopback by the relay channel (internal/remote's Via mark), or
	// onto loopback by a proxy that claims to forward.
	type via int
	const (
		lan via = iota
		relay
		proxy
	)
	do := func(how via, method, path, token, body string) (int, string) {
		t.Helper()
		var rd io.Reader
		if body != "" {
			rd = strings.NewReader(body)
		}
		r := httptest.NewRequest(method, path, rd)
		switch how {
		case lan:
			r.RemoteAddr = testPhone
			r.Host = strings.TrimPrefix(testLANURL, "http://")
		case relay:
			r.RemoteAddr, r.Host = "127.0.0.1:51000", "127.0.0.1:22776"
			r.Header.Set("Via", "1.1 "+remoteVia)
		case proxy:
			r.RemoteAddr, r.Host = "127.0.0.1:51000", "127.0.0.1:22776"
			r.Header.Set("X-Forwarded-For", "203.0.113.9")
		}
		if method != http.MethodGet {
			// What the dashboard and the phone's module bridge send (csrf.go).
			r.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			r.Header.Set(deviceTokenHeader, token)
		}
		w := httptest.NewRecorder()
		e.api.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}

	for _, how := range []via{lan, relay} {
		// The controller: the state, never the key; the pages; the store.
		code, body := do(how, http.MethodGet, "/v1/admin", controller.Token, "")
		var st AdminState
		_ = json.Unmarshal([]byte(body), &st)
		if code != 200 || !st.Admin || len(st.Installed) != 1 || st.Installed[0].ID != "alpha" {
			t.Fatalf("via %d: controller GET /v1/admin = %d %s", how, code, body)
		}
		if strings.Contains(body, e.admin.key) || strings.Contains(body, "CRA1.") {
			t.Errorf("via %d: the admin state carries the key: %s", how, body)
		}
		if code, body := do(how, http.MethodGet, "/x/alpha/", controller.Token, ""); code != 200 || !strings.Contains(body, "module alpha") {
			t.Errorf("via %d: controller page = %d %q", how, code, body)
		}
		if code, _ := do(how, http.MethodGet, "/x/alpha/js/app.js", controller.Token, ""); code != 200 {
			t.Errorf("via %d: controller nested file = %d", how, code)
		}
		if code, _ := do(how, http.MethodGet, "/x/beta/", controller.Token, ""); code != 404 {
			t.Errorf("via %d: a module the key does not name = %d, want 404", how, code)
		}
		if code, _ := do(how, http.MethodPut, "/v1/x/alpha/docs/notes/a", controller.Token, `{"x":1}`); code != 200 {
			t.Errorf("via %d: controller store write = %d", how, code)
		}
		if code, body := do(how, http.MethodGet, "/v1/x/alpha/docs/notes/a", controller.Token, ""); code != 200 || !strings.Contains(body, `"x":1`) {
			t.Errorf("via %d: controller store read = %d %s", how, code, body)
		}
		if code, _ := do(how, http.MethodPatch, "/v1/x/alpha/docs/notes/a", controller.Token, `{"y":2}`); code != 200 {
			t.Errorf("via %d: controller store update = %d", how, code)
		}
		if code, _ := do(how, http.MethodGet, "/v1/x/alpha/docs/notes", controller.Token, ""); code != 200 {
			t.Errorf("via %d: controller store list = %d", how, code)
		}
		if code, _ := do(how, http.MethodDelete, "/v1/x/alpha/docs/notes/a", controller.Token, ""); code != 200 {
			t.Errorf("via %d: controller store delete = %d", how, code)
		}
		if code, _ := do(how, http.MethodPut, "/v1/x/beta/docs/notes/a", controller.Token, `{}`); code != 403 {
			t.Errorf("via %d: controller writing a module the key does not name = %d, want 403", how, code)
		}
		// The key itself is the machine's, whatever the role.
		if code, _ := do(how, http.MethodPut, "/v1/admin", controller.Token, `{"key":""}`); code != 403 {
			t.Errorf("via %d: controller PUT /v1/admin = %d, want 403", how, code)
		}
		if code, _ := do(how, http.MethodDelete, "/v1/admin", controller.Token, ""); code != 403 {
			t.Errorf("via %d: controller DELETE /v1/admin = %d, want 403", how, code)
		}
		if e.admin.key == "" {
			t.Fatalf("via %d: a device cleared the admin key", how)
		}
		// A page is read, never written.
		if code, _ := do(how, http.MethodPost, "/x/alpha/", controller.Token, `{}`); code != 403 && code != 405 {
			t.Errorf("via %d: controller POST to a page = %d", how, code)
		}

		// A viewer: nothing of modules.
		for _, c := range []struct{ method, path, body string }{
			{http.MethodGet, "/v1/admin", ""},
			{http.MethodGet, "/x/alpha/", ""},
			{http.MethodGet, "/x/alpha/js/app.js", ""},
			{http.MethodGet, "/v1/x/alpha/docs/notes", ""},
			{http.MethodPut, "/v1/x/alpha/docs/notes/a", `{}`},
			{http.MethodPut, "/v1/admin", `{"key":""}`},
		} {
			if code, _ := do(how, c.method, c.path, viewer.Token, c.body); code != 403 {
				t.Errorf("via %d: viewer %s %s = %d, want 403", how, c.method, c.path, code)
			}
		}

		// No token: not paired, for the pages as for the API.
		for _, p := range []string{"/v1/admin", "/x/alpha/", "/x/alpha", "/v1/x/alpha/docs/notes"} {
			if code, _ := do(how, http.MethodGet, p, "", ""); code != 401 {
				t.Errorf("via %d: unpaired GET %s = %d, want 401", how, p, code)
			}
		}
	}

	// Loopback a proxy relayed is a device: without a token 401, with the
	// controller's it is the controller, never the owner.
	if code, _ := do(proxy, http.MethodGet, "/x/alpha/", "", ""); code != 401 {
		t.Errorf("forwarded loopback without a token = %d, want 401", code)
	}
	if code, _ := do(proxy, http.MethodPut, "/v1/admin", controller.Token, `{"key":""}`); code != 403 {
		t.Errorf("forwarded loopback PUT /v1/admin = %d, want 403", code)
	}

	// Taking control away closes the module at the next request.
	if !ps.SetRole(controller.ID, pairing.RoleViewer) {
		t.Fatal("could not take control away")
	}
	if code, _ := do(lan, http.MethodGet, "/x/alpha/", controller.Token, ""); code != 403 {
		t.Errorf("a former controller's page = %d, want 403", code)
	}
}

// moduleCaller is the handlers' own check, apart from the gate: a viewer or a
// device still waiting is no caller even if a request reached the handler.
func TestModuleCallerChecksTheRole(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/x/alpha/", nil)
	r.RemoteAddr = testPhone
	if moduleCaller(r) {
		t.Error("a request from the network with no device is a module caller")
	}
	for _, c := range []struct {
		dev  pairing.Device
		want bool
	}{
		{pairing.Device{Role: pairing.RoleController}, true},
		{pairing.Device{Role: pairing.RoleViewer}, false},
		{pairing.Device{Role: pairing.RoleController, Pending: true}, false},
	} {
		d := c.dev
		rr := r.WithContext(context.WithValue(r.Context(), deviceKey{}, &d))
		if got := moduleCaller(rr); got != c.want {
			t.Errorf("%+v: %v, want %v", c.dev, got, c.want)
		}
	}
	local := httptest.NewRequest(http.MethodGet, "/x/alpha/", nil)
	local.RemoteAddr, local.Host = "127.0.0.1:5000", "127.0.0.1:22776"
	if !moduleCaller(local) {
		t.Error("the machine itself is not a module caller")
	}
}
