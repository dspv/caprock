package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/projects"
	"github.com/dspv/caprock/internal/store"
)

// fakeShells is a ShellController with one shell, "sh-1", in dir.
type fakeShells struct {
	dir     string
	started []string
}

func (f *fakeShells) StartShell(_ context.Context, cwd string, _, _ int) (ShellInfo, error) {
	f.started = append(f.started, cwd)
	return ShellInfo{ID: "sh-2", Cwd: cwd}, nil
}
func (f *fakeShells) Shells() []ShellInfo    { return []ShellInfo{{ID: "sh-1", Cwd: f.dir}} }
func (f *fakeShells) IsShell(id string) bool { return id == "sh-1" }

// projectsServer is a daemon's API with network access on, two paired
// phones, a projects service on an in-memory store and fakeShells.
func projectsServer(t *testing.T) (s *Server, home string, viewer, controller string, sh *fakeShells) {
	t.Helper()
	home = fakeHome(t)
	st, err := store.Open(context.Background(), ":memory:", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := projects.New(st, bus.New(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := svc.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Close) // before home is removed: Windows will not delete a watched folder
	sh = &fakeShells{dir: home}
	s, _, v, c := pairedPhones(t, Deps{Store: st, Projects: svc, Shells: sh, Agents: &fakeAgents{avail: true}})
	return s, home, v.Token, c.Token, sh
}

func call(t *testing.T, s *Server, from, token, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	r.RemoteAddr = from
	r.Host = "127.0.0.1:22776"
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set(deviceTokenHeader, token)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

const machine = "127.0.0.1:51000"

// A controller phone starts work under home — adds, creates and clones a
// project there — and nowhere else; a viewer cannot; the machine can
// anywhere.
func TestAPhoneStartsProjectsUnderHome(t *testing.T) {
	s, home, viewer, controller, _ := projectsServer(t)
	inside := filepath.Join(home, "dev", "app")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	j := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	cases := []struct {
		name, from, token, body string
		want                    int
	}{
		{"controller adds a folder under home", testPhone, controller, j(map[string]any{"path": inside}), 200},
		{"controller adds a folder outside home", testPhone, controller, j(map[string]any{"path": outside}), 403},
		{"controller creates under home", testPhone, controller, j(map[string]any{"create": map[string]any{"parent": inside, "name": "new"}}), 200},
		{"controller creates outside home", testPhone, controller, j(map[string]any{"create": map[string]any{"parent": outside, "name": "new"}}), 403},
		{"controller clones outside home", testPhone, controller, j(map[string]any{"clone": map[string]any{"url": "https://example.invalid/a/b", "parent": outside}}), 403},
		{"controller clones a local path under home", testPhone, controller, j(map[string]any{"clone": map[string]any{"url": "/etc", "parent": inside}}), 400},
		{"controller sends a relative path", testPhone, controller, j(map[string]any{"path": "dev/app"}), 403},
		{"viewer adds a folder under home", testPhone, viewer, j(map[string]any{"path": inside}), 403},
		{"the machine adds a folder anywhere", machine, "", j(map[string]any{"path": outside}), 200},
		{"two at once", machine, "", j(map[string]any{"path": outside, "create": map[string]any{"parent": outside, "name": "x"}}), 400},
		{"none", machine, "", `{}`, 400},
	}
	for _, tc := range cases {
		if w := call(t, s, tc.from, tc.token, "POST", "/v1/projects", tc.body); w.Code != tc.want {
			t.Errorf("%s: %d, want %d (%s)", tc.name, w.Code, tc.want, w.Body.String())
		}
	}
	w := call(t, s, testPhone, viewer, "GET", "/v1/projects", "")
	var got struct {
		Projects []projects.View `json:"projects"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != 200 || len(got.Projects) != 3 {
		t.Fatalf("viewer list: %d %s", w.Code, w.Body.String())
	}
}

// Shells are the machine's: a phone, whatever its role, cannot start one,
// list them, or reach a shell's terminal through the agent routes it may
// otherwise use (21-app.md decision 8: shells from the phone are P1).
func TestShellsStayOnTheMachine(t *testing.T) {
	s, home, _, controller, sh := projectsServer(t)
	for _, c := range []struct{ method, path, body string }{
		{"POST", "/v1/shells", `{"cwd":"` + filepath.ToSlash(home) + `"}`},
		{"GET", "/v1/shells", ""},
		{"POST", "/v1/agents/sh-1/input", `{"data":"ls\r"}`},
		{"POST", "/v1/agents/sh-1/signal", `{"action":"kill"}`},
		{"GET", "/v1/agents/sh-1/term", ""},
	} {
		if w := call(t, s, testPhone, controller, c.method, c.path, c.body); w.Code != http.StatusForbidden {
			t.Errorf("controller %s %s: %d, want 403", c.method, c.path, w.Code)
		}
	}
	// A session the controller may type into is still typed into.
	if w := call(t, s, testPhone, controller, "POST", "/v1/agents/agent-1/input", `{"data":"hi"}`); w.Code != http.StatusNoContent {
		t.Errorf("controller input to a session: %d", w.Code)
	}
	if len(sh.started) != 0 {
		t.Fatal("a phone started a shell")
	}
	// The machine starts one in a project and lists it under the project.
	w := call(t, s, machine, "", "POST", "/v1/projects", `{"path":"`+filepath.ToSlash(home)+`"}`)
	var added struct {
		Project projects.View `json:"project"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &added)
	if w.Code != 200 || added.Project.ID == 0 {
		t.Fatalf("add home: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "POST", "/v1/shells", `{"project_id":`+itoa(added.Project.ID)+`}`); w.Code != 200 || len(sh.started) != 1 {
		t.Fatalf("machine start: %d %s", w.Code, w.Body.String())
	}
	w = call(t, s, machine, "", "GET", "/v1/shells?project="+itoa(added.Project.ID), "")
	var list struct {
		Shells []ShellInfo `json:"shells"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list.Shells) != 1 || list.Shells[0].ProjectID != added.Project.ID || !list.Shells[0].Internal || list.Shells[0].Kind != "shell" {
		t.Fatalf("list: %s", w.Body.String())
	}
	w = call(t, s, machine, "", "GET", "/v1/shells?project=99999", "")
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list.Shells) != 0 {
		t.Fatalf("another project's shells: %s", w.Body.String())
	}
}

// A dirty worktree is refused with 409 and the reason; PATCH and DELETE
// answer 404 for an unknown project.
func TestWorktreeAndProjectErrors(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	s, home, _, controller, _ := projectsServer(t)
	repo := filepath.Join(home, "repo")
	_ = os.MkdirAll(repo, 0o755)
	run := func(dir string, a ...string) {
		c := exec.Command("git", append([]string{"-C", dir}, a...)...)
		c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", a, err, out)
		}
	}
	run(repo, "init", "-q", "-b", "main")
	run(repo, "commit", "-q", "--allow-empty", "-m", "init")
	w := call(t, s, machine, "", "POST", "/v1/projects", `{"path":"`+filepath.ToSlash(repo)+`"}`)
	var added struct {
		Project projects.View `json:"project"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &added)
	id := itoa(added.Project.ID)
	w = call(t, s, testPhone, controller, "POST", "/v1/projects/"+id+"/worktrees", `{"branch":"phone-work","create":true}`)
	var wt struct {
		Worktree struct {
			Path string `json:"path"`
		} `json:"worktree"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &wt); err != nil || w.Code != 200 {
		t.Fatalf("controller worktree: %d %s", w.Code, w.Body.String())
	}
	_ = os.WriteFile(filepath.Join(wt.Worktree.Path, "wip"), []byte("x"), 0o600)
	if w := call(t, s, testPhone, controller, "DELETE", "/v1/projects/"+id+"/worktrees/phone-work", ""); w.Code != http.StatusConflict {
		t.Fatalf("dirty worktree: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "PATCH", "/v1/projects/99999", `{"name":"x"}`); w.Code != http.StatusNotFound {
		t.Fatalf("patch unknown: %d", w.Code)
	}
	if w := call(t, s, machine, "", "DELETE", "/v1/projects/99999", ""); w.Code != http.StatusNotFound {
		t.Fatalf("delete unknown: %d", w.Code)
	}
	if w := call(t, s, testPhone, controller, "DELETE", "/v1/projects/"+id, ""); w.Code != http.StatusNoContent {
		t.Fatalf("unlist: %d", w.Code)
	}
	if _, err := os.Stat(filepath.Join(wt.Worktree.Path, "wip")); err != nil {
		t.Fatal("unlisting a project touched its files")
	}
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

// liveShells is a ShellController whose shells run until ended.
type liveShells struct {
	n    int
	live []ShellInfo
}

func (f *liveShells) StartShell(_ context.Context, cwd string, _, _ int) (ShellInfo, error) {
	f.n++
	sh := ShellInfo{ID: "sh-" + itoa(int64(f.n)), Cwd: cwd}
	f.live = append(f.live, sh)
	return sh, nil
}
func (f *liveShells) Shells() []ShellInfo { return f.live }
func (f *liveShells) IsShell(id string) bool {
	for _, sh := range f.live {
		if sh.ID == id {
			return true
		}
	}
	return false
}

// Every client showing a tab whose program exited asks for a shell in its
// place; they must all get the same one, not one shell each.
func TestOneShellReplacesAnExitedSession(t *testing.T) {
	home := fakeHome(t)
	f := &liveShells{}
	s, _, _, _ := pairedPhones(t, Deps{Shells: f})
	start := func(body string) string {
		t.Helper()
		w := call(t, s, machine, "", "POST", "/v1/shells", body)
		var out struct {
			Shell ShellInfo `json:"shell"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatalf("start: %d %s", w.Code, w.Body.String())
		}
		return out.Shell.ID
	}
	cwd := `"cwd":"` + filepath.ToSlash(home) + `"`
	a := start(`{` + cwd + `,"replaces":"sess-1"}`)
	b := start(`{` + cwd + `,"replaces":"sess-1"}`)
	if a != b || f.n != 1 {
		t.Fatalf("two clients got %s and %s, %d shells started; want one", a, b, f.n)
	}
	if c := start(`{` + cwd + `,"replaces":"sess-2"}`); c == a {
		t.Fatal("another session's tab got the same shell")
	}
	if start(`{`+cwd+`}`) == a {
		t.Fatal("a plain new shell reused a replacement")
	}
	// Once that shell has ended, the replacement is forgotten.
	f.live = f.live[1:]
	if d := start(`{` + cwd + `,"replaces":"sess-1"}`); d == a {
		t.Fatal("an ended shell was handed out again")
	}
}
