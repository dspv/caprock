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

// On a fresh computer Claude Code is switched on, the rest off (AgentOn).
var claudeMissing = Agent{ID: "claude", Label: "Claude Code", On: true, Install: "irm https://claude.ai/install.ps1 | iex"}
var codexMissing = Agent{ID: "codex", Label: "Codex", Install: "npm install -g @openai/codex"}

func row(t *testing.T, r Report, id string) AgentRow {
	t.Helper()
	for _, a := range r.Agents {
		if a.ID == id {
			return a
		}
	}
	t.Fatalf("no %s row in %+v", id, r.Agents)
	return AgentRow{}
}

// A fresh Windows PC — the owner's test machine of 2026-11-20 — is told
// every step, in order, each with what to do; the project is last and
// optional, and never a step left.
func TestNothingInstalledOnWindows(t *testing.T) {
	r := Build(Inputs{GOOS: "windows", Git: Git{Fresh: true}, Agents: []Agent{claudeMissing, codexMissing}, Link: Link{Supported: true}})
	if r.Ready() {
		t.Fatal("ready with nothing installed")
	}
	keys := []string{}
	for _, it := range r.Items {
		keys = append(keys, it.Key)
		want := Missing
		if it.Key == KeyProject {
			want = NotNeeded
		}
		if it.State != want {
			t.Errorf("%s: %s, want %s", it.Key, it.State, want)
		}
		if it.Detail == "" {
			t.Errorf("%s says nothing", it.Key)
		}
		if it.Optional != (it.Key == KeyProject) {
			t.Errorf("%s optional %v", it.Key, it.Optional)
		}
	}
	if strings.Join(keys, ",") != "git,agent,link,project" {
		t.Fatalf("order %v", keys)
	}
	git := item(t, r, KeyGit)
	if git.Command != "winget install --id Git.Git -e --source winget" || !strings.Contains(git.Detail, "Claude Code needs it on Windows") {
		t.Fatalf("git: %+v", git)
	}
	if strings.Contains(git.Detail, "Restart") {
		t.Fatal("a fresh PATH should not ask for a restart")
	}
	a := item(t, r, KeyAgent)
	if a.Label != "Agents" || a.Command != claudeMissing.Install || a.Detail != "Install Claude Code, then sign in." {
		t.Fatalf("agent: %+v", a)
	}
	if c := row(t, r, "claude"); !c.On || c.State != Missing || c.Step != StepInstall || c.Command != claudeMissing.Install {
		t.Fatalf("claude row: %+v", c)
	}
	if c := row(t, r, "codex"); c.On || c.State != NotNeeded || c.Command != "" {
		t.Fatalf("codex row, off: %+v", c)
	}
}

// The switches' defaults: a choice wins; else installed is on, and Claude
// Code is on on a fresh computer; the rest off.
func TestAgentOn(t *testing.T) {
	for _, c := range []struct {
		id        string
		installed bool
		chosen    map[string]bool
		want      bool
	}{
		{"claude", false, nil, true},
		{"codex", false, nil, false},
		{"codex", true, nil, true},
		{"gemini", true, map[string]bool{"gemini": false}, false},
		{"claude", false, map[string]bool{"claude": false}, false},
		{"opencode", false, map[string]bool{"opencode": true}, true},
	} {
		if got := AgentOn(c.id, c.installed, c.chosen); got != c.want {
			t.Errorf("%s installed=%v chosen=%v: %v", c.id, c.installed, c.chosen, got)
		}
	}
}

// Every switched-on agent walks install → sign in → ready; the item is ok
// once none switched on is left and one is ready. Off ones are not counted.
func TestAgentsAsSwitches(t *testing.T) {
	claude := Agent{ID: "claude", Label: "Claude Code", On: true, Installed: true, SignIn: OK}
	codex := Agent{ID: "codex", Label: "Codex", On: true, Installed: true, SignIn: Missing, SignInCommand: "codex login"}
	r := Build(Inputs{GOOS: "linux", Agents: []Agent{claude, codex}})
	if c := row(t, r, "codex"); c.State != Missing || c.Step != StepSignIn || c.Command != "codex login" {
		t.Fatalf("codex: %+v", c)
	}
	if a := item(t, r, KeyAgent); a.State != Missing || a.Command != "codex login" || !strings.Contains(a.Detail, "Sign in to Codex") {
		t.Fatalf("one on, not signed in, holds the item: %+v", a)
	}
	codex.On = false
	r = Build(Inputs{GOOS: "linux", Agents: []Agent{claude, codex}})
	if a := item(t, r, KeyAgent); a.State != OK || a.Detail != "Claude Code ready." || a.Command != "" {
		t.Fatalf("codex off: %+v", a)
	}
	if c := row(t, r, "claude"); c.State != OK || c.Step != "" {
		t.Fatalf("claude: %+v", c)
	}
	// Codex signed in by the keyring, unreadable: unknown, offered, and it
	// holds nothing up beside a ready Claude Code.
	codex = Agent{ID: "codex", Label: "Codex", On: true, Installed: true, SignIn: Unknown, SignInCommand: "codex login"}
	r = Build(Inputs{GOOS: "linux", Agents: []Agent{claude, codex}})
	if c := row(t, r, "codex"); c.State != Unknown || c.Command != "codex login" {
		t.Fatalf("codex unknown: %+v", c)
	}
	if a := item(t, r, KeyAgent); a.State != OK {
		t.Fatalf("unknown beside ready: %+v", a)
	}
	// Codex alone, unreadable: unknown, never ticked.
	claude.On = false
	r = Build(Inputs{GOOS: "linux", Agents: []Agent{claude, codex}})
	if a := item(t, r, KeyAgent); a.State != Unknown || a.Command != "codex login" {
		t.Fatalf("codex alone: %+v", a)
	}
	// Everything off: the item says to switch one on.
	codex.On = false
	r = Build(Inputs{GOOS: "linux", Agents: []Agent{claude, codex}})
	if a := item(t, r, KeyAgent); a.State != Missing || !strings.Contains(a.Detail, "Switch on at least one") {
		t.Fatalf("none on: %+v", a)
	}
	// An agent whose sign-in is its own words (OpenCode's provider).
	oc := Agent{ID: "opencode", Label: "OpenCode", On: true, Installed: true, SignIn: Missing, SignInText: "Connect a provider: run opencode auth login.", SignInCommand: "opencode auth login"}
	if c := row(t, Build(Inputs{GOOS: "linux", Agents: []Agent{oc}}), "opencode"); c.Detail != "Installed. Connect a provider: run opencode auth login." {
		t.Fatalf("opencode: %+v", c)
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
		Agents:   []Agent{{ID: "claude", Label: "Claude Code", On: true, Installed: true, SignIn: OK, SignInCommand: "claude auth login"}, codexMissing},
		Projects: 2,
		Link:     Link{Supported: true, On: true, Allowed: []string{"MacBook"}},
	})
	if !r.Ready() {
		t.Fatalf("not ready: %+v", r)
	}
	if d := item(t, r, KeyAgent).Detail; d != "Claude Code ready." {
		t.Fatalf("agent %q", d)
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

// Owner, 2026-11-20: a project is optional — agents start in any folder
// picked in New agent. A computer with none is ready.
func TestReadyWithoutAProject(t *testing.T) {
	r := Build(Inputs{
		GOOS:     "windows",
		Git:      Git{Found: true, Fresh: true},
		Agents:   []Agent{{ID: "claude", Label: "Claude Code", On: true, Installed: true, SignIn: OK}},
		Link:     Link{Supported: true, On: true, Allowed: []string{"MacBook"}},
		CloneDir: `C:\Users\dima\dev`,
	})
	if !r.Ready() {
		t.Fatalf("not ready without a project: %+v", r)
	}
	p := item(t, r, KeyProject)
	if p.State != NotNeeded || !p.Optional || p.Label != "Projects here" || r.Items[len(r.Items)-1].Key != KeyProject {
		t.Fatalf("project: %+v", p)
	}
}

// Claude Code without a sign-in: its row is missing with its sign-in.
func TestSignIn(t *testing.T) {
	r := Build(Inputs{GOOS: "darwin", Agents: []Agent{{ID: "claude", Label: "Claude Code", On: true, Installed: true, SignIn: Missing, SignInCommand: "claude auth login"}}})
	if c := row(t, r, "claude"); c.State != Missing || c.Step != StepSignIn || c.Command != "claude auth login" {
		t.Fatalf("claude: %+v", c)
	}
	if r.Ready() {
		t.Fatal("not signed in is not ready")
	}
	for _, it := range r.Items {
		if it.Key == KeySignIn {
			t.Fatal("the sign-in item is no longer sent")
		}
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

// Owner, 2026-11-20: Claude Code's installer left claude in ~/.local/bin with
// that folder off his PATH. Caprock found it; his terminals did not.
func TestAgentOffThePath(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "home", "dima")
	local := filepath.Join(home, ".local", "bin")
	files := map[string]bool{filepath.Join(local, "claude"): true, filepath.Join(local, "claude.exe"): true}
	isFile := func(p string) bool { return files[p] }
	for _, goos := range []string{"windows", "darwin", "linux"} {
		o := OffPath{GOOS: goos, Home: home, Dirs: []string{filepath.Join(string(filepath.Separator), "usr", "bin")}, IsFile: isFile}
		if d := o.Dir("claude"); d != local {
			t.Fatalf("%s: off the PATH reads %q, want %q", goos, d, local)
		}
		o.Dirs = append(o.Dirs, local+string(filepath.Separator))
		if d := o.Dir("claude"); d != "" {
			t.Fatalf("%s: on the PATH reads %q", goos, d)
		}
		if d := (OffPath{GOOS: goos, Home: home, IsFile: isFile}).Dir("codex"); d != "" {
			t.Fatalf("%s: an agent not in ~/.local/bin reads %q", goos, d)
		}
	}
	// Found elsewhere on the PATH: a terminal runs that one.
	elsewhere := filepath.Join(string(filepath.Separator), "opt", "bin")
	files[filepath.Join(elsewhere, "claude")] = true
	if d := (OffPath{GOOS: "linux", Home: home, Dirs: []string{elsewhere}, IsFile: isFile}).Dir("claude"); d != "" {
		t.Fatalf("found on the PATH elsewhere, still %q", d)
	}
	// Windows compares folders as Windows does: case and separator aside.
	if d := (OffPath{GOOS: "windows", Home: home, Dirs: []string{strings.ToUpper(local)}, IsFile: isFile}).Dir("claude"); d != "" && strings.ToUpper(local) != local {
		t.Fatalf("windows: case-different PATH entry not matched: %q", d)
	}

	off := Agent{ID: "claude", Label: "Claude Code", On: true, Installed: true, SignIn: Missing, SignInCommand: "claude auth login", OffPath: `C:\Users\dima\.local\bin`}
	r := Build(Inputs{GOOS: "windows", Git: Git{Found: true, Fresh: true}, Agents: []Agent{off, codexMissing}})
	a := item(t, r, KeyAgent)
	if a.State != Missing || a.Detail != "Claude Code is installed, but terminals can't find it. Add C:\\Users\\dima\\.local\\bin to your PATH so `claude` works in a terminal." {
		t.Fatalf("windows agent: %+v", a)
	}
	if !strings.Contains(a.Command, `$env:USERPROFILE\.local\bin`) || !strings.Contains(a.Command, "'User'") || strings.Contains(a.Command, "'Machine'") {
		t.Fatalf("windows fix: %q", a.Command)
	}
	if a.Command != PathFix("windows", "") || a.Action != ActionPath {
		t.Fatalf("command %q", a.Command)
	}
	if c := row(t, r, "claude"); c.Step != StepPath || c.Action != ActionPath || c.Command != a.Command || !strings.Contains(c.Detail, "terminals can't find it") {
		t.Fatalf("claude row: %+v", c)
	}
	// On the PATH: the next step is the sign-in.
	off.OffPath = ""
	if c := row(t, Build(Inputs{GOOS: "windows", Agents: []Agent{off}}), "claude"); c.Step != StepSignIn {
		t.Fatalf("on the PATH: %+v", c)
	}
}

func TestPathFixPerShell(t *testing.T) {
	line := `export PATH="$HOME/.local/bin:$PATH"`
	for _, c := range []struct{ goos, shell, rc string }{
		{"darwin", "zsh", "~/.zshrc"},
		{"darwin", "bash", "~/.bash_profile"},
		{"linux", "bash", "~/.bashrc"},
		{"linux", "sh", "~/.profile"},
		{"linux", "", "~/.profile"},
	} {
		want := "grep -qsxF '" + line + "' " + c.rc + " || echo '" + line + "' >> " + c.rc
		if got := PathFix(c.goos, c.shell); got != want {
			t.Errorf("%s %s: %q, want %q", c.goos, c.shell, got, want)
		}
	}
	if got := PathFix("linux", "fish"); got != "fish_add_path -U $HOME/.local/bin" {
		t.Errorf("fish: %q", got)
	}
}

// The project item names where a clone goes (owner, 2026-11-20).
func TestProjectItemSaysWhereClonesGo(t *testing.T) {
	d := item(t, Build(Inputs{GOOS: "windows", CloneDir: `C:\Users\dima\dev`}), KeyProject).Detail
	if d != `Optional. Clone a repository here into C:\Users\dima\dev, or pick any folder in New agent on your laptop.` {
		t.Fatalf("project %q", d)
	}
	if d := item(t, Build(Inputs{GOOS: "linux"}), KeyProject).Detail; d != "Optional. Clone a repository here, or pick any folder in New agent on your laptop." {
		t.Fatalf("no folder known: %q", d)
	}
}
