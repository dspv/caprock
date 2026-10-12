package api

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/projects"
)

// The copies routes list every worktree, refuse one a shell runs in, remove
// one that is free, and stay on the machine.
func TestCopiesRoutes(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	s, home, viewer, controller, sh := projectsServer(t)
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
	w = call(t, s, machine, "", "POST", "/v1/projects/"+id+"/worktrees", `{"branch":"work","create":true}`)
	var wt struct {
		Worktree struct {
			Path string `json:"path"`
		} `json:"worktree"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &wt); err != nil || w.Code != 200 {
		t.Fatalf("worktree: %d %s", w.Code, w.Body.String())
	}
	sh.dir = filepath.Join(wt.Worktree.Path, "sub")
	w = call(t, s, machine, "", "GET", "/v1/projects/"+id+"/copies", "")
	var v projects.CopiesView
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil || w.Code != 200 || len(v.Copies) != 2 {
		t.Fatalf("copies: %d %s", w.Code, w.Body.String())
	}
	if c := v.Copies[1]; !c.Caprock || len(c.Live) != 1 || c.Live[0] != "a shell tab" {
		t.Fatalf("a shell inside makes the copy busy: %+v", c)
	}
	if c := v.Copies[0]; !c.Main || len(c.Live) != 0 {
		t.Fatalf("a shell in a copy nested under the main checkout made the main checkout busy: %+v", c)
	}
	for _, tok := range []string{viewer, controller} {
		if w := call(t, s, testPhone, tok, "GET", "/v1/projects/"+id+"/copies", ""); w.Code != http.StatusForbidden {
			t.Fatalf("a phone listed copies: %d", w.Code)
		}
		if w := call(t, s, testPhone, tok, "POST", "/v1/projects/"+id+"/copies/remove", `{"copies":[{"path":"x"}]}`); w.Code != http.StatusForbidden {
			t.Fatalf("a phone removed copies: %d", w.Code)
		}
	}
	if w := call(t, s, machine, "", "POST", "/v1/projects/"+id+"/copies/remove", `{"copies":[]}`); w.Code != http.StatusBadRequest {
		t.Fatalf("empty body: %d", w.Code)
	}
	p, _ := json.Marshal(wt.Worktree.Path)
	body := `{"copies":[{"path":` + string(p) + `}],"delete_merged_branches":true}`
	var res struct {
		Results []projects.CopyRemoved `json:"results"`
	}
	w = call(t, s, machine, "", "POST", "/v1/projects/"+id+"/copies/remove", body)
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if w.Code != 200 || len(res.Results) != 1 || res.Results[0].Removed || !strings.Contains(res.Results[0].Error, "shell tab") {
		t.Fatalf("busy copy: %d %s", w.Code, w.Body.String())
	}
	sh.dir = filepath.Join(home, "elsewhere")
	w = call(t, s, machine, "", "POST", "/v1/projects/"+id+"/copies/remove", body)
	res.Results = nil
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if w.Code != 200 || len(res.Results) != 1 || !res.Results[0].Removed || res.Results[0].BranchDeleted != "work" {
		t.Fatalf("free copy: %d %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(wt.Worktree.Path); !os.IsNotExist(err) {
		t.Fatal("the copy is still on disk")
	}
}

// The cleanup routes answer for a repository, refuse a bad body, and stay on
// the machine; the mode is a settings word.
func TestCleanupRoutes(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	s, home, viewer, controller, _ := projectsServer(t)
	repo := filepath.Join(home, "repo")
	_ = os.MkdirAll(repo, 0o755)
	c := exec.Command("git", "-C", repo, "init", "-q", "-b", "main")
	if out, err := c.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	w := call(t, s, machine, "", "POST", "/v1/projects", `{"path":"`+filepath.ToSlash(repo)+`"}`)
	var added struct {
		Project projects.View `json:"project"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &added)
	id := itoa(added.Project.ID)
	w = call(t, s, machine, "", "GET", "/v1/projects/"+id+"/cleanup", "")
	var v projects.CleanupView
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil || w.Code != 200 || v.Mode != projects.CleanupAsk || v.Candidates == nil || v.History == nil {
		t.Fatalf("cleanup: %d %s", w.Code, w.Body.String())
	}
	for _, tok := range []string{viewer, controller} {
		for _, r := range [][3]string{{"GET", "/cleanup", ""}, {"POST", "/cleanup", `{"paths":["x"]}`}, {"POST", "/cleanup/restore", `{"ids":["x"]}`}} {
			if w := call(t, s, testPhone, tok, r[0], "/v1/projects/"+id+r[1], r[2]); w.Code != http.StatusForbidden {
				t.Fatalf("a phone reached %s %s: %d", r[0], r[1], w.Code)
			}
		}
	}
	for _, r := range [][2]string{{"/cleanup", `{"paths":[]}`}, {"/cleanup/restore", `{}`}} {
		if w := call(t, s, machine, "", "POST", "/v1/projects/"+id+r[0], r[1]); w.Code != http.StatusBadRequest {
			t.Fatalf("%s with an empty body: %d", r[0], w.Code)
		}
	}
	w = call(t, s, machine, "", "POST", "/v1/projects/"+id+"/cleanup/restore", `{"ids":["nope"]}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "no such removal") {
		t.Fatalf("restore unknown: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "GET", "/v1/projects/999/cleanup", ""); w.Code != http.StatusNotFound {
		t.Fatalf("no such project: %d", w.Code)
	}
}

func TestWorktreeCleanupSettingValidates(t *testing.T) {
	e := newEnv(t)
	if code := e.putSettings(t, map[string]any{"worktree_cleanup": "auto"}); code != http.StatusOK {
		t.Fatalf("auto: %d", code)
	}
	var st Settings
	if code := e.get(t, "/v1/settings", &st); code != http.StatusOK || st.WorktreeCleanup != projects.CleanupAuto {
		t.Fatalf("GET: %d %q", code, st.WorktreeCleanup)
	}
	for _, bad := range []string{"always", ""} {
		if code := e.putSettings(t, map[string]any{"worktree_cleanup": bad}); code != http.StatusBadRequest {
			t.Fatalf("%q answered %d, want 400", bad, code)
		}
	}
}
