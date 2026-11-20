package readiness

import (
	"path/filepath"
	"strings"
	"testing"
)

func item(t *testing.T, r Report, key string) Item {
	t.Helper()
	for _, it := range r.Items {
		if it.Key == key {
			return it
		}
	}
	t.Fatalf("no %s item in %+v", key, r)
	return Item{}
}

var claudeMissing = Agent{ID: "claude", Label: "Claude Code", Install: "irm https://claude.ai/install.ps1 | iex"}
var codexMissing = Agent{ID: "codex", Label: "Codex", Install: "npm install -g @openai/codex"}

// A fresh Windows PC — the owner's test machine of 2026-11-20 — is told
// every step, in order, each with what to do.
func TestNothingInstalledOnWindows(t *testing.T) {
	r := Build(Inputs{GOOS: "windows", Git: Git{Fresh: true}, Agents: []Agent{claudeMissing, codexMissing}, Link: Link{Supported: true}})
	if r.Ready() {
		t.Fatal("ready with nothing installed")
	}
	keys := []string{}
	for _, it := range r.Items {
		keys = append(keys, it.Key)
		if it.State != Missing {
			t.Errorf("%s: %s, want missing", it.Key, it.State)
		}
		if it.Detail == "" {
			t.Errorf("%s says nothing", it.Key)
		}
	}
	if strings.Join(keys, ",") != "git,agent,signin,project,link" {
		t.Fatalf("order %v", keys)
	}
	git := item(t, r, KeyGit)
	if git.Command != "winget install --id Git.Git -e --source winget" || !strings.Contains(git.Detail, "Claude Code needs it on Windows") {
		t.Fatalf("git: %+v", git)
	}
	if strings.Contains(git.Detail, "Restart") {
		t.Fatal("a fresh PATH should not ask for a restart")
	}
	if a := item(t, r, KeyAgent); a.Command != claudeMissing.Install {
		t.Fatalf("agent: %+v", a)
	}
	if s := item(t, r, KeySignIn); s.Command != "" || !strings.Contains(s.Detail, "Install an agent first") {
		t.Fatalf("signin before an agent: %+v", s)
	}
}

func TestGitCommandPerOS(t *testing.T) {
	if c := item(t, Build(Inputs{GOOS: "darwin", Git: Git{Fresh: true}}), KeyGit).Command; c != "xcode-select --install" {
		t.Fatalf("darwin: %q", c)
	}
	lin := item(t, Build(Inputs{GOOS: "linux", Git: Git{Fresh: true}}), KeyGit)
	if lin.Command != "" || !strings.Contains(lin.Detail, "apt install git") {
		t.Fatalf("linux: %+v", lin)
	}
	if d := item(t, Build(Inputs{GOOS: "linux"}), KeyGit).Detail; !strings.Contains(d, "Restart Caprock to see it") {
		t.Fatalf("a stale PATH must say restart: %q", d)
	}
}

// Ready: every item ticked, and the link names who may start agents here.
func TestReadyComputer(t *testing.T) {
	r := Build(Inputs{
		GOOS:     "windows",
		Git:      Git{Found: true, Fresh: true},
		Agents:   []Agent{{ID: "claude", Label: "Claude Code", Installed: true, SignIn: OK, SignInCommand: "claude auth login"}, codexMissing},
		Projects: 2,
		Link:     Link{Supported: true, On: true, Allowed: []string{"MacBook"}},
	})
	if !r.Ready() {
		t.Fatalf("not ready: %+v", r)
	}
	if l := item(t, r, KeyAgent).Label; l != "Claude Code" {
		t.Fatalf("agent label %q", l)
	}
	if d := item(t, r, KeyProject).Detail; d != "2 projects." {
		t.Fatalf("project %q", d)
	}
	if d := item(t, r, KeyLink).Detail; d != "MacBook can start agents here." {
		t.Fatalf("link %q", d)
	}
	for _, it := range r.Items {
		if it.Command != "" {
			t.Errorf("%s done but offers %q", it.Key, it.Command)
		}
	}
}

// Claude Code without a sign-in is missing with its sign-in; Codex alone,
// unreadable, is unknown and never ticked.
func TestSignIn(t *testing.T) {
	r := Build(Inputs{GOOS: "darwin", Agents: []Agent{{ID: "claude", Label: "Claude Code", Installed: true, SignIn: Missing, SignInCommand: "claude auth login"}}})
	if s := item(t, r, KeySignIn); s.State != Missing || s.Command != "claude auth login" || s.Label != "Sign in to Claude Code" {
		t.Fatalf("claude: %+v", s)
	}
	r = Build(Inputs{GOOS: "linux", Agents: []Agent{claudeMissing, {ID: "codex", Label: "Codex", Installed: true, SignIn: Unknown, SignInCommand: "codex login"}}})
	if s := item(t, r, KeySignIn); s.State != Unknown || s.Command != "codex login" {
		t.Fatalf("codex: %+v", s)
	}
	if r.Ready() {
		t.Fatal("an unknown sign-in is not ready")
	}
}

func TestLinkStates(t *testing.T) {
	cases := []struct {
		l    Link
		want string
	}{
		{Link{}, "Update Caprock"},
		{Link{Supported: true}, "caprock setup --link"},
		{Link{Supported: true, On: true, Waiting: []string{"MacBook"}}, `caprock machines allow "MacBook"`},
		{Link{Supported: true, Allowed: []string{"MacBook", "Air"}}, "caprock remote on"},
	}
	for _, c := range cases {
		it := linkItem(c.l)
		if it.State != Missing || !strings.Contains(it.Detail+" "+it.Command, c.want) {
			t.Errorf("%+v: %+v, want %q", c.l, it, c.want)
		}
	}
}

func TestGitFinder(t *testing.T) {
	files := map[string]bool{}
	isFile := func(p string) bool { return files[p] }
	env := func(k string) string {
		return map[string]string{"ProgramFiles": `C:\Program Files`}[k]
	}
	bin := filepath.Join("home", "u", "bin")
	f := GitFinder{GOOS: "linux", Dirs: []string{bin}, IsFile: isFile, Env: env}
	if f.Found() {
		t.Fatal("found nothing")
	}
	files[filepath.Join(bin, "git")] = true
	if !f.Found() {
		t.Fatal("git on PATH")
	}

	// Windows: git.exe on PATH, or Git for Windows' own folder off it.
	w := GitFinder{GOOS: "windows", IsFile: isFile, Env: env}
	if w.Found() {
		t.Fatal("windows found nothing")
	}
	files[filepath.Join(`C:\Program Files`, "Git", "cmd", "git.exe")] = true
	if !w.Found() {
		t.Fatal("windows: Program Files")
	}

	// macOS: /usr/bin/git is Apple's installer stub, not Git, until the
	// Command Line Tools are there.
	files = map[string]bool{"/usr/bin/git": true}
	m := GitFinder{GOOS: "darwin", Dirs: []string{"/usr/bin"}, IsFile: func(p string) bool { return files[filepath.ToSlash(p)] }, Env: env}
	if m.Found() {
		t.Fatal("the stub counted as Git")
	}
	files["/Library/Developer/CommandLineTools/usr/bin/git"] = true
	if !m.Found() {
		t.Fatal("Command Line Tools")
	}
}
