package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// keepTempDirs lets the Recent list offer temp folders, which is where every
// test's folders live.
func keepTempDirs(t *testing.T) {
	t.Helper()
	was := junkTempDirs
	junkTempDirs = func() []string { return nil }
	t.Cleanup(func() { junkTempDirs = was })
}

// Recent leaves out where nobody adds a project on purpose: temp folders
// (scratchpads, test runs), Caprock's own data directory (quick chats) and an
// agent's worktree under .claude/worktrees (owner, 2026-10-09).
func TestRecentJunk(t *testing.T) {
	data := "/Users/x/Library/Application Support/caprock"
	for _, junk := range []string{
		"/tmp/x", "/private/tmp/claude-501/scratchpad", "/private/var/folders/ab/T/run",
		data + "/chats/2026-10-09-101500",
		"/Users/x/dev/api/.claude/worktrees/agent-1",
	} {
		if !recentJunk(junk, data) {
			t.Errorf("%s was offered", junk)
		}
	}
	for _, ok := range []string{"/Users/x/dev/api", "/Users/x/dev/claude-worktrees", "/Users/x/Library/Application Support/caprock-notes"} {
		if recentJunk(ok, data) {
			t.Errorf("%s was left out", ok)
		}
	}
}

func TestRecentDirsLeavesOutTheDataDir(t *testing.T) {
	keepTempDirs(t)
	e := newEnv(t)
	data := t.TempDir()
	e.api.d.DataDir = data
	chat := filepath.Join(data, "chats", "2026-10-09-101500")
	if err := os.MkdirAll(chat, 0o755); err != nil {
		t.Fatal(err)
	}
	live := t.TempDir()
	e.seed(t, live)
	seedIn(t, e, "chat", chat)
	var got []recentDir
	if code := e.get(t, "/v1/recent-dirs", &got); code != 200 {
		t.Fatalf("status %d", code)
	}
	if len(got) != 1 || got[0].Dir != live {
		t.Fatalf("recent dirs = %+v, want only %s", got, live)
	}
}

// The stat says what the Add project sheet shows under a typed path, and is
// held to the browse boundary: outside the root is the browse 404 whether or
// not the path exists there.
func TestBrowseStat(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"empty", "full/inner"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	e := newEnv(t)
	e.setBrowseRoot(t, root)
	stat := func(p string) (statResponse, int) {
		var out statResponse
		code := e.get(t, "/v1/browse/stat?path="+url.QueryEscape(p), &out)
		return out, code
	}
	cases := []struct {
		path                             string
		exists, dir, empty, parentExists bool
	}{
		{filepath.Join(root, "empty"), true, true, true, true},
		{filepath.Join(root, "full"), true, true, false, true},
		{filepath.Join(root, "file.txt"), true, false, false, true},
		{filepath.Join(root, "new"), false, false, false, true},
		{filepath.Join(root, "a", "b"), false, false, false, false},
	}
	for _, c := range cases {
		got, code := stat(c.path)
		if code != 200 || got.Exists != c.exists || got.IsDir != c.dir || got.Empty != c.empty || got.ParentExists != c.parentExists {
			t.Errorf("%s: %d %+v, want exists=%v dir=%v empty=%v parent=%v", c.path, code, got, c.exists, c.dir, c.empty, c.parentExists)
		}
	}
	outside := t.TempDir()
	for _, p := range []string{outside, filepath.Join(outside, "missing"), "relative/path", ""} {
		if _, code := stat(p); code != 404 {
			t.Errorf("%q: %d, want the browse 404", p, code)
		}
	}
}

func TestBrowseStatExpandsTheHomeFolder(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home directory")
	}
	if got := expandTilde("~/dev"); got != filepath.Join(home, "dev") {
		t.Errorf("expandTilde = %q", got)
	}
	if got := expandTilde("/a/~/b"); got != "/a/~/b" {
		t.Errorf("a ~ that does not lead was expanded: %q", got)
	}
	for v, ok := range map[string]bool{"": false, "~": true, "~/dev": true, "dev": false, "~/a\nb": false} {
		if validDefaultFolder(v) != ok {
			t.Errorf("validDefaultFolder(%q) = %v", v, !ok)
		}
	}
	if !validDefaultFolder(home) {
		t.Errorf("an absolute path was refused")
	}
}

// POST /v1/browse/mkdir makes one folder whose parent already exists inside
// the browse root, and nothing else: no parents, no git, no project.
func TestBrowseMkdir(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	e := newEnv(t)
	e.setBrowseRoot(t, root)
	mkdir := func(p string) (int, map[string]string) {
		t.Helper()
		b, _ := json.Marshal(map[string]string{"path": p})
		req, err := http.NewRequest(http.MethodPost, e.srv.URL+"/v1/browse/mkdir", bytes.NewReader(b))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]string
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	made := filepath.Join(root, "newhop5")
	if code, out := mkdir(made + string(filepath.Separator)); code != http.StatusCreated || out["path"] != made {
		t.Fatalf("mkdir: %d %v", code, out)
	}
	if fi, err := os.Stat(made); err != nil || !fi.IsDir() {
		t.Fatalf("the folder was not made: %v", err)
	}
	if entries, _ := os.ReadDir(made); len(entries) != 0 {
		t.Errorf("the new folder holds %d entries; nothing but the folder is made", len(entries))
	}
	if code, _ := mkdir(made); code != http.StatusConflict {
		t.Errorf("again: %d, want 409", code)
	}
	if code, _ := mkdir(filepath.Join(root, "file.txt")); code != http.StatusConflict {
		t.Errorf("over a file: %d, want 409", code)
	}

	// A missing parent is never made.
	if code, _ := mkdir(filepath.Join(root, "a", "b")); code != http.StatusNotFound {
		t.Errorf("missing parent: %d, want 404", code)
	}
	if _, err := os.Stat(filepath.Join(root, "a")); !os.IsNotExist(err) {
		t.Errorf("a missing parent was made: %v", err)
	}
	// Under a file, outside the root, relative, empty, the filesystem root.
	outside := t.TempDir()
	for _, p := range []string{
		filepath.Join(root, "file.txt", "x"),
		filepath.Join(outside, "x"),
		root + string(filepath.Separator) + ".." + string(filepath.Separator) + "escape-x",
		"relative/x",
		"",
		filepath.VolumeName(root) + string(filepath.Separator),
	} {
		if code, _ := mkdir(p); code != http.StatusNotFound {
			t.Errorf("%q: %d, want 404", p, code)
		}
	}
	if _, err := os.Stat(filepath.Join(outside, "x")); !os.IsNotExist(err) {
		t.Errorf("a folder outside the root was made: %v", err)
	}

	// A link inside the root that points out of it does not carry a mkdir out.
	if err := os.Symlink(outside, filepath.Join(root, "out")); err == nil {
		if code, _ := mkdir(filepath.Join(root, "out", "y")); code != http.StatusNotFound {
			t.Errorf("through a link out of the root: %d, want 404", code)
		}
		if _, err := os.Stat(filepath.Join(outside, "y")); !os.IsNotExist(err) {
			t.Errorf("a folder was made through a link: %v", err)
		}
	}
}
