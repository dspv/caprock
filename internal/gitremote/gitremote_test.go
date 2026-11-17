package gitremote

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestWebURL(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"git@github.com:dspv/caprock.git", "https://github.com/dspv/caprock"},
		{"git@github.com:dspv/caprock", "https://github.com/dspv/caprock"},
		{"https://github.com/dspv/caprock.git", "https://github.com/dspv/caprock"},
		{"https://github.com/dspv/caprock/", "https://github.com/dspv/caprock"},
		{"https://user:token@github.com/dspv/caprock.git", "https://github.com/dspv/caprock"},
		{"ssh://git@github.com/dspv/caprock.git", "https://github.com/dspv/caprock"},
		{"ssh://git@gitlab.example.com:2222/group/sub/project.git", "https://gitlab.example.com/group/sub/project"},
		{"git+ssh://git@github.com/dspv/caprock.git", "https://github.com/dspv/caprock"},
		{"git@github.mycorp.com:team/service.git", "https://github.mycorp.com/team/service"},
		{"https://git.example.com:8443/team/service.git", "https://git.example.com:8443/team/service"},
		{"git@bitbucket.org:team/repo.git", "https://bitbucket.org/team/repo"},
		{"git://git.kernel.org/pub/scm/git/git.git", "https://git.kernel.org/pub/scm/git/git"},
		{"git@ssh.dev.azure.com:v3/org/project/repo", "https://dev.azure.com/org/project/_git/repo"},
	}
	for _, c := range cases {
		got, ok := WebURL(c.in)
		if !ok || got != c.want {
			t.Errorf("WebURL(%q) = %q, %v; want %q", c.in, got, ok, c.want)
		}
	}
	// No web host to link to: a local path, a Windows path, file://, an ssh alias.
	for _, in := range []string{"", "/srv/git/repo.git", "../other", `C:\repos\x.git`, "C:/repos/x.git",
		"file:///srv/git/repo.git", "myalias:team/repo.git", "origin"} {
		if got, ok := WebURL(in); ok {
			t.Errorf("WebURL(%q) = %q, want no link", in, got)
		}
	}
}

func TestBranchURL(t *testing.T) {
	gh := "https://github.com/dspv/caprock"
	if got := BranchURL(gh, "fix/terminal", "master"); got != gh+"/tree/fix/terminal" {
		t.Errorf("github branch: %q", got)
	}
	if got := BranchURL(gh, "master", "master"); got != "" {
		t.Errorf("default branch should not link a branch page: %q", got)
	}
	if got := BranchURL(gh, "main", ""); got != "" {
		t.Errorf("main with an unknown default is treated as the default: %q", got)
	}
	if got := BranchURL("https://gitlab.com/g/p", "feat/x", "main"); got != "https://gitlab.com/g/p/-/tree/feat/x" {
		t.Errorf("gitlab branch: %q", got)
	}
	if got := BranchURL("https://bitbucket.org/t/r", "dev", "main"); got != "https://bitbucket.org/t/r/src/dev" {
		t.Errorf("bitbucket branch: %q", got)
	}
	if got := BranchURL("https://git.example.com/t/r", "dev", "main"); got != "" {
		t.Errorf("unknown host gets no guessed branch URL: %q", got)
	}
	if got := BranchURL(gh, "feat/a b#1", "master"); got != gh+"/tree/feat/a%20b%231" {
		t.Errorf("escaping: %q", got)
	}
}

func TestFromToolPost(t *testing.T) {
	created := `{"tool_input":{"command":"gh pr create --base master --title \"fix(terminal): attach dropped documents\" --body-file /tmp/b.md"},
		"tool_response":{"stdout":"https://github.com/dspv/caprock/pull/162","gitOperation":{"pr":{"number":162,"url":"https://github.com/dspv/caprock/pull/162","action":"created"}}}}`
	pr, ok := FromToolPost([]byte(created))
	if !ok || pr.Number != 162 || pr.Action != "created" || pr.Title != "fix(terminal): attach dropped documents" ||
		pr.URL != "https://github.com/dspv/caprock/pull/162" {
		t.Fatalf("created: %+v %v", pr, ok)
	}
	merged := `{"tool_input":{"command":"gh pr merge 95 --squash"},"tool_response":{"gitOperation":{"pr":{"number":95,"url":"https://github.com/dspv/caprock/pull/95","action":"merged"}}}}`
	if pr, ok := FromToolPost([]byte(merged)); !ok || pr.Action != "merged" || pr.Number != 95 || pr.Title != "" {
		t.Fatalf("merged: %+v %v", pr, ok)
	}
	// Without Claude Code's record: a gh pr create whose output has the URL.
	plain := `{"tool_input":{"command":"cd x && gh pr create -t 'feat: a thing' --body \"$(cat <<'EOF'\nbody\nEOF\n)\""},"tool_response":{"stdout":"remote: \nhttps://github.com/o/r/pull/7\n"}}`
	if pr, ok := FromToolPost([]byte(plain)); !ok || pr.Number != 7 || pr.Title != "feat: a thing" || pr.Action != "created" {
		t.Fatalf("plain create: %+v %v", pr, ok)
	}
	// A merge without the record is never read as merged; a failed command is nothing.
	for _, p := range []string{
		`{"tool_input":{"command":"gh pr merge 7"},"tool_response":{"stdout":"https://github.com/o/r/pull/7"}}`,
		`{"is_error":true,"tool_input":{"command":"gh pr create -t x"},"tool_response":{"stdout":"https://github.com/o/r/pull/7"}}`,
		`{"tool_input":{"command":"git push"},"tool_response":{"gitOperation":{"push":{"branch":"master"}}}}`,
		`not json`,
	} {
		if pr, ok := FromToolPost([]byte(p)); ok {
			t.Errorf("FromToolPost(%s) = %+v, want nothing", p, pr)
		}
	}
	// A title built by a subshell is not guessed.
	sub := `{"tool_input":{"command":"gh pr create --title \"$(git log -1 --format=%s)\""},"tool_response":{"gitOperation":{"pr":{"number":3,"url":"https://github.com/o/r/pull/3","action":"created"}}}}`
	if pr, _ := FromToolPost([]byte(sub)); pr.Title != "" {
		t.Errorf("subshell title guessed: %q", pr.Title)
	}
}

// A push is read from Claude Code's record alone: its branch, never a failed
// command's, never one without a branch.
func TestPushFromToolPost(t *testing.T) {
	push := `{"tool_input":{"command":"git push -u origin feat/cursor-agent"},"tool_response":{"stdout":"","gitOperation":{"push":{"branch":"feat/cursor-agent"}}}}`
	if b, ok := PushFromToolPost([]byte(push)); !ok || b != "feat/cursor-agent" {
		t.Fatalf("push: %q %v", b, ok)
	}
	// A push recorded beside a pull request still names its branch.
	both := `{"tool_response":{"gitOperation":{"pr":{"number":3,"url":"https://github.com/o/r/pull/3","action":"created"},"push":{"branch":"fix/x"}}}}`
	if b, ok := PushFromToolPost([]byte(both)); !ok || b != "fix/x" {
		t.Fatalf("both: %q %v", b, ok)
	}
	for _, p := range []string{
		`{"is_error":true,"tool_response":{"gitOperation":{"push":{"branch":"feat/x"}}}}`,
		`{"tool_response":{"gitOperation":{"push":{"branch":""}}}}`,
		`{"tool_response":{"gitOperation":{"push":{}}}}`,
		`{"tool_response":{"gitOperation":{"pr":{"number":3,"url":"https://github.com/o/r/pull/3","action":"created"}}}}`,
		`{"tool_response":"plain text"}`,
		`{"tool_input":{"command":"git push"}}`,
		`not json`,
	} {
		if b, ok := PushFromToolPost([]byte(p)); ok {
			t.Errorf("PushFromToolPost(%s) = %q, want nothing", p, b)
		}
	}
}

// Without Claude Code's gitOperation a push is read from git's own output,
// and only for a `git push`: Cursor's terminal output, Codex's plain text.
func TestPushFromOutput(t *testing.T) {
	cases := []struct {
		name, payload, want string
	}{
		{"fast-forward (Cursor's terminal)", `{"tool_input":{"command":"git push"},"tool_response":{"stdout":"Enumerating objects: 18, done.\nTo github.com:o/site.git\n   385159d..252476a  master -> master"}}`, "master"},
		{"new branch after cd", `{"tool_input":{"command":"cd /w/x && git push -u origin HEAD"},"tool_response":{"stdout":"remote: Create a pull request\nTo github.com:o/x.git\n * [new branch]      HEAD -> feat/cursor-parity\nbranch 'feat/cursor-parity' set up to track 'origin/feat/cursor-parity'."}}`, "feat/cursor-parity"},
		{"forced update", `{"tool_input":{"command":"git push -f"},"tool_response":{"stderr":"To github.com:o/x.git\r\n + 1a2b3c...4d5e6f fix/y -> fix/y (forced update)\r\n"}}`, "fix/y"},
		{"refs/heads spelled out", `{"tool_input":{"command":"git push origin HEAD:refs/heads/rel"},"tool_response":{"stdout":"To https://github.com/o/x\n * [new branch]      HEAD -> refs/heads/rel"}}`, "rel"},
		{"Codex text response", `{"tool_input":{"command":"git push"},"tool_response":"To github.com:o/x.git\n   a..b  main -> main"}`, "main"},
	}
	for _, c := range cases {
		if b, ok := PushFromToolPost([]byte(c.payload)); !ok || b != c.want {
			t.Errorf("%s: %q %v, want %q", c.name, b, ok, c.want)
		}
	}
	for _, p := range []string{
		`{"tool_input":{"command":"git push"},"tool_response":{"stdout":"Everything up-to-date"}}`,
		`{"tool_input":{"command":"git push"},"tool_response":{"stdout":"To github.com:o/x.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs"}}`,
		`{"tool_input":{"command":"git push --tags"},"tool_response":{"stdout":"To github.com:o/x.git\n * [new tag]         v1.0 -> v1.0"}}`,
		`{"tool_input":{"command":"git push origin --delete old"},"tool_response":{"stdout":"To github.com:o/x.git\n - [deleted]         old"}}`,
		// A fetch prints the same arrows; only a push counts.
		`{"tool_input":{"command":"git fetch"},"tool_response":{"stdout":"From github.com:o/x\nTo x\n * [new branch]      feat/z -> origin/feat/z"}}`,
		`{"is_error":true,"tool_input":{"command":"git push"},"tool_response":{"stdout":"To github.com:o/x.git\n   a..b  main -> main"}}`,
	} {
		if b, ok := PushFromToolPost([]byte(p)); ok {
			t.Errorf("PushFromToolPost(%s) = %q, want nothing", p, b)
		}
	}
}

// Lookup against real repositories: a clone with an ssh remote on a branch,
// and a linked worktree, whose .git is a file pointing elsewhere.
func TestLookup(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	dir := t.TempDir()
	run := func(d string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", d}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@x", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@x")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	repo := filepath.Join(dir, "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	run(repo, "init", "-q", "-b", "master")
	run(repo, "commit", "-q", "--allow-empty", "-m", "init")
	run(repo, "remote", "add", "upstream", "https://example.org/x/y.git")
	run(repo, "remote", "add", "origin", "git@github.com:dspv/caprock.git")
	run(repo, "update-ref", "refs/remotes/origin/master", "HEAD")
	run(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master")
	run(repo, "checkout", "-q", "-b", "fix/thing")

	r, ok := Lookup(ctx, repo)
	if !ok {
		t.Fatal("not read as a repository")
	}
	if r.URL != "https://github.com/dspv/caprock" || r.Branch != "fix/thing" || r.DefaultBranch != "master" ||
		r.BranchURL != "https://github.com/dspv/caprock/tree/fix/thing" {
		t.Fatalf("repo: %+v", r)
	}

	wt := filepath.Join(dir, "wt")
	run(repo, "worktree", "add", "-q", "-b", "feat/wt", wt)
	w, ok := Lookup(ctx, wt)
	if !ok || w.URL != "https://github.com/dspv/caprock" || w.Branch != "feat/wt" {
		t.Fatalf("worktree: %+v %v", w, ok)
	}

	plain := filepath.Join(dir, "plain")
	_ = os.MkdirAll(plain, 0o755)
	if p, ok := Lookup(ctx, plain); ok || p.Root != plain || p.URL != "" {
		t.Fatalf("not a repository: %+v %v", p, ok)
	}
}
