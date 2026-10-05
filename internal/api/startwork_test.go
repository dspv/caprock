package api

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Starting work from the phone (WP-15; ADR-034 as amended): every action —
// add, create, clone, worktree — is a controller's. A viewer is refused each
// with 403 and may still read the list, the worktrees and the clones in
// flight.
func TestAViewerIsRefusedEveryStartWorkAction(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	s, home, viewer, _, _ := projectsServer(t)
	repo := gitRepo(t, filepath.Join(home, "dev", "repo"))
	id := addAsMachine(t, s, repo)
	j := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	for _, c := range []struct{ name, method, path, body string }{
		{"add", "POST", "/v1/projects", j(map[string]any{"path": repo})},
		{"create", "POST", "/v1/projects", j(map[string]any{"create": map[string]any{"parent": home, "name": "new", "git_init": true}})},
		{"clone", "POST", "/v1/projects", j(map[string]any{"clone": map[string]any{"url": "https://github.com/octocat/Hello-World", "parent": home}, "op_id": "v1"})},
		{"worktree", "POST", "/v1/projects/" + id + "/worktrees", `{"branch":"from-phone","create":true}`},
		{"remove a worktree", "DELETE", "/v1/projects/" + id + "/worktrees/from-phone", ""},
		{"rename", "PATCH", "/v1/projects/" + id, `{"name":"x"}`},
		{"unlist", "DELETE", "/v1/projects/" + id, ""},
	} {
		if w := call(t, s, testPhone, viewer, c.method, c.path, c.body); w.Code != http.StatusForbidden {
			t.Errorf("viewer %s: %d, want 403 (%s)", c.name, w.Code, w.Body.String())
		}
	}
	if _, err := os.Stat(filepath.Join(home, "new")); err == nil {
		t.Fatal("a viewer created a folder")
	}
	for _, path := range []string{"/v1/projects", "/v1/projects/ops", "/v1/projects/" + id + "/worktrees"} {
		if w := call(t, s, testPhone, viewer, "GET", path, ""); w.Code != http.StatusOK {
			t.Errorf("viewer GET %s: %d", path, w.Code)
		}
	}
	w := call(t, s, testPhone, viewer, "GET", "/v1/projects/ops", "")
	var ops struct {
		Ops []json.RawMessage `json:"ops"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &ops); err != nil || len(ops.Ops) != 0 {
		t.Fatalf("a viewer's clone started: %s", w.Body.String())
	}
}

// A controller's clone takes an https:// or git@ address and nothing else —
// not a local path, file://, http://, ssh://, a transport that runs a command,
// an option, nor another user's ssh form — and starts nothing when refused.
func TestAPhoneClonesOnlyHTTPSOrGitAt(t *testing.T) {
	s, home, _, controller, _ := projectsServer(t)
	bare := filepath.Join(home, "bare.git")
	_ = os.MkdirAll(bare, 0o755)
	for _, url := range []string{
		"file://" + filepath.ToSlash(bare),
		filepath.ToSlash(bare),
		"http://github.com/octocat/Hello-World",
		"ssh://git@github.com/octocat/Hello-World",
		"ext::sh -c touch% /tmp/pwned",
		"--upload-pack=touch /tmp/pwned",
		"git@-oProxyCommand=x:repo",
		"alice@example.com:repo.git",
		"https://",
		"git@github.com:octocat/Hello World",
		"",
	} {
		body, _ := json.Marshal(map[string]any{"clone": map[string]any{"url": url, "parent": home}, "op_id": "x1"})
		if w := call(t, s, testPhone, controller, "POST", "/v1/projects", string(body)); w.Code != http.StatusBadRequest {
			t.Errorf("clone %q: %d, want 400 (%s)", url, w.Code, w.Body.String())
		}
	}
	w := call(t, s, testPhone, controller, "GET", "/v1/projects/ops", "")
	var ops struct {
		Ops []json.RawMessage `json:"ops"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &ops); err != nil || len(ops.Ops) != 0 {
		t.Fatalf("a refused clone started: %s", w.Body.String())
	}
}

// Where a phone's new project or clone lands: under home, one plain folder
// name, never through a link out of home, never over something that exists.
func TestAPhoneStartsWorkOnlyInAFreeFolderUnderHome(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	s, home, _, controller, _ := projectsServer(t)
	outside := t.TempDir()
	escape := filepath.Join(home, "escape")
	if err := os.Symlink(outside, escape); err != nil {
		t.Skip("no symlinks here")
	}
	taken := filepath.Join(home, "taken")
	_ = os.MkdirAll(taken, 0o755)
	_ = os.WriteFile(filepath.Join(taken, "keep"), []byte("mine"), 0o600)
	if err := os.Symlink(filepath.Join(outside, "nowhere"), filepath.Join(home, "dangling")); err != nil {
		t.Fatal(err)
	}
	repo := gitRepo(t, filepath.Join(outside, "repo"))
	outsideID := addAsMachine(t, s, repo)
	j := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	clone := func(parent, name string) string {
		return j(map[string]any{"clone": map[string]any{"url": "https://github.com/octocat/Hello-World", "parent": parent, "name": name}, "op_id": "c-" + name})
	}
	for _, c := range []struct {
		name, method, path, body string
		want                     int
	}{
		{"create through a link out of home", "POST", "/v1/projects", j(map[string]any{"create": map[string]any{"parent": escape, "name": "x"}}), 403},
		{"clone through a link out of home", "POST", "/v1/projects", clone(escape, "x"), 403},
		{"clone with a relative parent", "POST", "/v1/projects", clone("dev", "x"), 403},
		{"clone with .. in the parent", "POST", "/v1/projects", clone(home+"/../..", "x"), 403},
		{"create named ..", "POST", "/v1/projects", j(map[string]any{"create": map[string]any{"parent": home, "name": ".."}}), 400},
		{"create named a/b", "POST", "/v1/projects", j(map[string]any{"create": map[string]any{"parent": home, "name": "../b"}}), 400},
		{"clone named ../b", "POST", "/v1/projects", clone(home, "../b"), 400},
		{"create over an existing folder", "POST", "/v1/projects", j(map[string]any{"create": map[string]any{"parent": home, "name": "taken"}}), 400},
		{"clone over an existing folder", "POST", "/v1/projects", clone(home, "taken"), 400},
		{"clone over a dangling link", "POST", "/v1/projects", clone(home, "dangling"), 400},
		{"worktree in a project outside home", "POST", "/v1/projects/" + outsideID + "/worktrees", `{"branch":"x","create":true}`, 403},
	} {
		if w := call(t, s, testPhone, controller, c.method, c.path, c.body); w.Code != c.want {
			t.Errorf("%s: %d, want %d (%s)", c.name, w.Code, c.want, w.Body.String())
		}
	}
	if b, err := os.ReadFile(filepath.Join(taken, "keep")); err != nil || string(b) != "mine" {
		t.Fatal("an existing folder was touched")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 1 {
		t.Fatalf("something was written outside home: %v", entries)
	}
}

// gitRepo makes a repository with one commit at dir.
func gitRepo(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, a := range [][]string{{"init", "-q", "-b", "main"}, {"commit", "-q", "--allow-empty", "-m", "init"}} {
		c := exec.Command("git", append([]string{"-C", dir}, a...)...)
		c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", a, err, out)
		}
	}
	return dir
}

// addAsMachine lists dir from the machine and returns the project's id.
func addAsMachine(t *testing.T, s *Server, dir string) string {
	t.Helper()
	w := call(t, s, machine, "", "POST", "/v1/projects", `{"path":`+jsonString(dir)+`}`)
	var added struct {
		Project struct {
			ID int64 `json:"id"`
		} `json:"project"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &added); err != nil || added.Project.ID == 0 {
		t.Fatalf("add %s: %d %s", dir, w.Code, w.Body.String())
	}
	return itoa(added.Project.ID)
}

func jsonString(v string) string { b, _ := json.Marshal(v); return string(b) }
