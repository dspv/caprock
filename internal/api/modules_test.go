package api

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
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
func newModuleEnv(t *testing.T) *moduleEnv {
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
	s := New(Deps{Store: st, Bus: bus.New(), Version: "test", Token: "tok", DataDir: data, Admin: admin,
		Now:         func() time.Time { return time.UnixMilli(1_000) },
		AdminVerify: func(k string) (modules.Grant, error) { return modules.ParseKeyWith(k, pub) },
	})
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

// A request relayed onto loopback is not the machine's, so it gets no module.
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
	if resp.StatusCode != 404 {
		t.Errorf("forwarded request: %d, want 404", resp.StatusCode)
	}
}
