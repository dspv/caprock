package api

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fsServer is changesServer with a linked worktree "wt" whose file differs.
func fsServer(t *testing.T) (s *Server, viewer, controller, repo, wt, id string) {
	t.Helper()
	s, viewer, controller, repo, id = changesServer(t)
	writeFile(t, filepath.Join(repo, "a.txt"), []byte("one\n"))
	wt = filepath.Join(filepath.Dir(repo), "wt")
	for _, a := range [][]string{{"-C", repo, "add", "-A"}, {"-C", repo, "commit", "-q", "-m", "a"}, {"-C", repo, "worktree", "add", "-q", "-b", "agent", wt}} {
		c := exec.Command("git", a...)
		c.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", a, err, out)
		}
	}
	writeFile(t, filepath.Join(wt, "a.txt"), []byte("two\n"))
	return s, viewer, controller, repo, wt, id
}

// The machine lists, compares and diffs; the listing says it may write.
func TestFilesTabReads(t *testing.T) {
	s, viewer, _, _, _, id := fsServer(t)
	base := "/v1/projects/" + id + "/fs"
	w := call(t, s, machine, "", "GET", base+"/list", "")
	var l struct {
		Entries []struct {
			Name string `json:"name"`
			Git  string `json:"git"`
		} `json:"entries"`
		Writable bool   `json:"writable"`
		Branch   string `json:"branch"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &l) != nil || !l.Writable || len(l.Entries) == 0 {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
	w = call(t, s, machine, "", "GET", base+"/compare?other=wt", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"a.txt":"diff"`) {
		t.Fatalf("compare: %d %s", w.Code, w.Body.String())
	}
	w = call(t, s, machine, "", "GET", base+"/diff?other=wt&path=a.txt", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `-one\n+two`) {
		t.Fatalf("diff: %d %s", w.Code, w.Body.String())
	}
	w = call(t, s, machine, "", "GET", base+"/changed?worktree=wt", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"path":"a.txt"`) {
		t.Fatalf("changed: %d %s", w.Code, w.Body.String())
	}
	// A paired viewer reads too, and is told it cannot write.
	w = call(t, s, testPhone, viewer, "GET", base+"/list", "")
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &l) != nil || l.Writable {
		t.Fatalf("viewer list: %d %s", w.Code, w.Body.String())
	}
	for _, p := range []string{"/list?path=..", "/list?path=" + url.QueryEscape("/etc"), "/diff?other=wt&path=../x"} {
		if w := call(t, s, machine, "", "GET", base+p, ""); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", p, w.Code, w.Body.String())
		}
	}
	if w := call(t, s, machine, "", "GET", base+"/list?worktree=nope", ""); w.Code != http.StatusNotFound {
		t.Errorf("unknown worktree: %d", w.Code)
	}
}

// Copy, move, mkdir and trash are the machine's alone: a viewer, and a
// controller as well, is refused, and nothing on disk changes.
func TestFilesTabWritesAreTheMachinesOnly(t *testing.T) {
	s, viewer, controller, repo, wt, id := fsServer(t)
	base := "/v1/projects/" + id + "/fs"
	writes := []struct{ path, body string }{
		{"/copy", `{"from":"wt","paths":["a.txt"],"to":"","dir":"","overwrite":true}`},
		{"/move", `{"from":"","paths":["a.txt"],"to":"","dir":"","name":"b.txt"}`},
		{"/mkdir", `{"worktree":"","dir":"","name":"d"}`},
		{"/trash", `{"worktree":"","paths":["a.txt"]}`},
	}
	for _, tok := range []string{viewer, controller} {
		for _, c := range writes {
			if w := call(t, s, testPhone, tok, "POST", base+c.path, c.body); w.Code != http.StatusForbidden {
				t.Errorf("device %s: %d %s", c.path, w.Code, w.Body.String())
			}
		}
	}
	if b, _ := os.ReadFile(filepath.Join(repo, "a.txt")); string(b) != "one\n" {
		t.Fatalf("a device's write landed: %q", b)
	}
	// The machine: a copy that would replace asks first, then replaces.
	w := call(t, s, machine, "", "POST", base+"/copy", `{"from":"wt","paths":["a.txt"],"to":"","dir":""}`)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), `"exists":["a.txt"]`) {
		t.Fatalf("copy over: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "POST", base+"/copy", writes[0].body); w.Code != http.StatusOK {
		t.Fatalf("copy: %d %s", w.Code, w.Body.String())
	}
	if b, _ := os.ReadFile(filepath.Join(repo, "a.txt")); string(b) != "two\n" {
		t.Fatalf("copied: %q", b)
	}
	if w := call(t, s, machine, "", "POST", base+"/mkdir", writes[2].body); w.Code != http.StatusOK {
		t.Fatalf("mkdir: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "POST", base+"/move", `{"from":"","paths":["a.txt"],"to":"","dir":"d"}`); w.Code != http.StatusOK {
		t.Fatalf("move: %d %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(repo, "d", "a.txt")); err != nil {
		t.Fatal(err)
	}
	// Never outside the roots, never git's own folder.
	for _, c := range []struct{ path, body string }{
		{"/trash", `{"worktree":"","paths":[".git"]}`},
		{"/trash", `{"worktree":"","paths":["../wt/a.txt"]}`},
		{"/copy", `{"from":"wt","paths":["a.txt"],"to":"","dir":"../.."}`},
		{"/mkdir", `{"worktree":"","dir":"","name":"../x"}`},
	} {
		if w := call(t, s, machine, "", "POST", base+c.path, c.body); w.Code != http.StatusBadRequest {
			t.Errorf("%s %s: %d %s", c.path, c.body, w.Code, w.Body.String())
		}
	}
	if _, err := os.Stat(filepath.Join(wt, "a.txt")); err != nil {
		t.Fatal("the worktree's file went")
	}
}
