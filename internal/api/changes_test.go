package api

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// changesServer is projectsServer with a repository under home, listed,
// tracking a bare remote, and git given an identity.
func changesServer(t *testing.T) (s *Server, viewer, controller, repo, id string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	var home string
	s, home, viewer, controller, _ = projectsServer(t)
	s.d.Projects.Env = func() []string {
		return append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	}
	repo = gitRepo(t, filepath.Join(home, "dev", "repo"))
	bare := filepath.Join(home, "remote.git")
	for _, a := range [][]string{{"init", "-q", "--bare", bare}, {"-C", repo, "remote", "add", "origin", bare}} {
		if out, err := exec.Command("git", a...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", a, err, out)
		}
	}
	return s, viewer, controller, repo, addAsMachine(t, s, repo)
}

// A viewer reads a worktree's changes and diffs, and is refused every write;
// nothing on disk moves.
func TestAViewerReadsChangesButCannotCommit(t *testing.T) {
	s, viewer, _, repo, id := changesServer(t)
	if err := os.WriteFile(filepath.Join(repo, "n.txt"), []byte("n\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := "/v1/projects/" + id + "/changes"
	for _, p := range []string{base, base + "/diff?path=n.txt"} {
		if w := call(t, s, testPhone, viewer, "GET", p, ""); w.Code != http.StatusOK {
			t.Errorf("viewer GET %s: %d %s", p, w.Code, w.Body.String())
		}
	}
	for _, c := range []struct{ path, body string }{
		{"/stage", `{"all":true}`},
		{"/unstage", `{"all":true}`},
		{"/discard", `{"paths":["n.txt"]}`},
		{"/commit", `{"message":"x","all":true}`},
		{"/push", ``},
		{"/pull", ``},
		{"/fetch", ``},
	} {
		if w := call(t, s, testPhone, viewer, "POST", base+c.path, c.body); w.Code != http.StatusForbidden {
			t.Errorf("viewer POST %s: %d, want 403 (%s)", c.path, w.Code, w.Body.String())
		}
	}
	if _, err := os.Stat(filepath.Join(repo, "n.txt")); err != nil {
		t.Fatal("a viewer's discard deleted the file")
	}
	if out, _ := exec.Command("git", "-C", repo, "log", "--oneline").Output(); strings.Count(string(out), "\n") != 1 {
		t.Fatalf("a viewer committed: %s", out)
	}
}

// A controller finishes the work from the phone: stage, commit, push.
func TestAControllerCommitsAndPushes(t *testing.T) {
	s, _, controller, repo, id := changesServer(t)
	if err := os.WriteFile(filepath.Join(repo, "n.txt"), []byte("n\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := "/v1/projects/" + id + "/changes"
	if w := call(t, s, testPhone, controller, "POST", base+"/stage", `{"paths":["n.txt"]}`); w.Code != http.StatusOK {
		t.Fatalf("stage: %d %s", w.Code, w.Body.String())
	}
	w := call(t, s, testPhone, controller, "POST", base+"/commit", `{"message":"From the phone"}`)
	var got struct {
		Commit struct {
			Subject string `json:"subject"`
		} `json:"commit"`
		Changes struct {
			Ahead     int  `json:"ahead"`
			Published bool `json:"published"`
		} `json:"changes"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &got) != nil || got.Commit.Subject != "From the phone" {
		t.Fatalf("commit: %d %s", w.Code, w.Body.String())
	}
	w = call(t, s, testPhone, controller, "POST", base+"/push", "")
	var pushed struct {
		Result struct {
			UpstreamSet bool   `json:"upstream_set"`
			Branch      string `json:"branch"`
		} `json:"result"`
		Changes struct {
			Published bool `json:"published"`
		} `json:"changes"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &pushed) != nil || !pushed.Result.UpstreamSet || !pushed.Changes.Published || pushed.Result.Branch != "main" {
		t.Fatalf("push: %d %s", w.Code, w.Body.String())
	}
}

// What the API answers when the request or git says no: 400 for a path
// outside the worktree, 404 for an unknown worktree or project, 409 for
// nothing to commit and a stale discard (with the fresh preview), 422 with
// the hook's output for a hook that refused.
func TestChangesRefusalsAreSaid(t *testing.T) {
	s, _, _, repo, id := changesServer(t)
	base := "/v1/projects/" + id + "/changes"
	if err := os.WriteFile(filepath.Join(repo, "n.txt"), []byte("n\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		method, path, body string
		want               int
	}{
		{"GET", base + "/diff?path=../../etc/passwd", "", 400},
		{"GET", base + "/diff?path=%2Fetc%2Fpasswd", "", 400},
		{"POST", base + "/stage", `{"paths":["../outside"]}`, 400},
		{"GET", base + "?worktree=nope", "", 404},
		{"GET", "/v1/projects/999/changes", "", 404},
		{"POST", base + "/commit", `{"message":"nothing staged"}`, 409},
		{"POST", base + "/commit", `{"message":"   "}`, 400},
		{"POST", base + "/stage", `not json`, 400},
	} {
		if w := call(t, s, machine, "", c.method, c.path, c.body); w.Code != c.want {
			t.Errorf("%s %s: %d, want %d (%s)", c.method, c.path, w.Code, c.want, w.Body.String())
		}
	}

	w := call(t, s, machine, "", "POST", base+"/discard", `{"paths":["n.txt"]}`)
	var pv struct {
		Preview struct {
			Confirm string `json:"confirm"`
		} `json:"preview"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &pv) != nil || pv.Preview.Confirm == "" {
		t.Fatalf("discard preview: %d %s", w.Code, w.Body.String())
	}
	if err := os.WriteFile(filepath.Join(repo, "n.txt"), []byte("an agent wrote more\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	w = call(t, s, machine, "", "POST", base+"/discard", `{"paths":["n.txt"],"confirm":"`+pv.Preview.Confirm+`"}`)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), `"preview"`) || !strings.Contains(w.Body.String(), `"kind":"stale"`) {
		t.Fatalf("stale discard: %d %s", w.Code, w.Body.String())
	}

	hook := filepath.Join(repo, ".git", "hooks", "pre-commit")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\necho 'tests failed: 2' >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	w = call(t, s, machine, "", "POST", base+"/commit", `{"message":"blocked","all":true}`)
	if w.Code != http.StatusUnprocessableEntity || !strings.Contains(w.Body.String(), `"kind":"hook"`) || !strings.Contains(w.Body.String(), "tests failed: 2") {
		t.Fatalf("hook: %d %s", w.Code, w.Body.String())
	}
}

// A phone writes only in a project under home; the machine anywhere.
func TestAPhoneCommitsOnlyUnderHome(t *testing.T) {
	s, _, controller, _, _ := changesServer(t)
	outside := gitRepo(t, filepath.Join(t.TempDir(), "repo"))
	oid := addAsMachine(t, s, outside)
	if err := os.WriteFile(filepath.Join(outside, "n.txt"), []byte("n\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := "/v1/projects/" + oid + "/changes"
	if w := call(t, s, testPhone, controller, "POST", base+"/stage", `{"all":true}`); w.Code != http.StatusForbidden {
		t.Fatalf("controller outside home: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, testPhone, controller, "GET", base, ""); w.Code != http.StatusOK {
		t.Fatalf("controller read outside home: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "POST", base+"/stage", `{"all":true}`); w.Code != http.StatusOK {
		t.Fatalf("machine outside home: %d %s", w.Code, w.Body.String())
	}
}
