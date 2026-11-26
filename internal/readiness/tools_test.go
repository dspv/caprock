package readiness

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func tool(t *testing.T, ts []Tool, id string) Tool {
	t.Helper()
	for _, x := range ts {
		if x.ID == id {
			return x
		}
	}
	t.Fatalf("no %s tool in %+v", id, ts)
	return Tool{}
}

// A fresh Windows PC (the owner's, 2026-11-26): Node.js and the GitHub CLI
// install with winget, answering its agreement prompt; the sign-in waits for
// the CLI; Claude Code's two rows are there because it is installed.
func TestToolsOnAFreshWindowsPC(t *testing.T) {
	ts := BuildTools("windows", ToolFacts{Claude: true})
	ids := []string{}
	for _, x := range ts {
		ids = append(ids, x.ID)
		if x.State != Missing || x.Detail == "" {
			t.Errorf("%s: %s %q", x.ID, x.State, x.Detail)
		}
	}
	if got := strings.Join(ids, ","); got != "node,gh,gh_auth,bypass,chrome_default" {
		t.Fatalf("order %s", got)
	}
	for _, id := range []string{ToolNode, ToolGH} {
		c := tool(t, ts, id).Command
		if !strings.HasPrefix(c, "winget install --id ") || !strings.Contains(c, "--accept-source-agreements") || !strings.Contains(c, "--accept-package-agreements") {
			t.Errorf("%s: %q", id, c)
		}
	}
	if c := tool(t, ts, ToolGHAuth).Command; c != "" {
		t.Errorf("sign-in offered before the CLI is there: %q", c)
	}
	for _, id := range []string{ToolBypass, ToolChrome} {
		if c := tool(t, ts, id).Command; c != "" {
			t.Errorf("%s is not a command, got %q", id, c)
		}
	}
}

func TestToolsDone(t *testing.T) {
	ts := BuildTools("darwin", ToolFacts{Node: true, GH: true, GHSignedIn: true, Claude: true, Bypass: true, Chrome: true})
	for _, x := range ts {
		if x.State != OK || x.Command != "" {
			t.Errorf("%s: %s %q", x.ID, x.State, x.Command)
		}
	}
}

// The sign-in is the device flow once the CLI is there; without Claude Code
// its two rows are left out.
func TestGHSignInAndNoClaude(t *testing.T) {
	ts := BuildTools("linux", ToolFacts{GH: true, Node: true})
	if len(ts) != 3 {
		t.Fatalf("%d tools: %+v", len(ts), ts)
	}
	if c := tool(t, ts, ToolGHAuth).Command; c != GHLogin || !strings.Contains(c, "--web") {
		t.Errorf("sign-in %q", c)
	}
}

// macOS installs with Homebrew when it is there, and says to get it first
// when not; Linux names the package managers and offers no button.
func TestInstallCommandsByOS(t *testing.T) {
	if c := tool(t, BuildTools("darwin", ToolFacts{Brew: true}), ToolNode).Command; c != "brew install node" {
		t.Errorf("mac node %q", c)
	}
	if c := tool(t, BuildTools("darwin", ToolFacts{Brew: true}), ToolGH).Command; c != "brew install gh" {
		t.Errorf("mac gh %q", c)
	}
	noBrew := tool(t, BuildTools("darwin", ToolFacts{}), ToolNode)
	if noBrew.Command != "" || !strings.Contains(noBrew.Detail, "Homebrew") {
		t.Errorf("mac without brew %+v", noBrew)
	}
	lin := tool(t, BuildTools("linux", ToolFacts{}), ToolGH)
	if lin.Command != "" || !strings.Contains(lin.Detail, "apt install gh") {
		t.Errorf("linux %+v", lin)
	}
}

// Tools never hold a computer back from ready, and a report without them
// (Inputs.Tools nil) has none.
func TestToolsAreNotItems(t *testing.T) {
	in := Inputs{GOOS: "windows", Git: Git{Found: true, Fresh: true},
		Agents: []Agent{{ID: "claude", Label: "Claude Code", On: true, Installed: true, SignIn: OK}},
		Link:   Link{Supported: true, On: true, Allowed: []string{"MacBook"}}}
	if r := Build(in); r.Tools != nil || !r.Ready() {
		t.Fatalf("without facts: %+v", r)
	}
	in.Tools = &ToolFacts{Claude: true}
	r := Build(in)
	if !r.Ready() || len(r.Tools) != 5 {
		t.Fatalf("with facts: ready %v, %d tools", r.Ready(), len(r.Tools))
	}
	for _, it := range r.Items {
		if strings.HasPrefix(it.Key, "node") || it.Key == ToolGH {
			t.Errorf("a tool became an item: %s", it.Key)
		}
	}
}

func TestToolFinder(t *testing.T) {
	files := map[string]bool{}
	is := func(p string) bool { return files[filepath.ToSlash(p)] }
	env := func(k string) string {
		switch k {
		case "ProgramFiles":
			return "C:/Program Files"
		case "LOCALAPPDATA":
			return "C:/Users/me/AppData/Local"
		}
		return ""
	}
	win := ToolFinder{GOOS: "windows", Env: env, IsFile: is}
	if win.Found(ToolNode) || win.Found(ToolGH) {
		t.Fatal("found on an empty disk")
	}
	// Off the PATH, in the installers' own folders.
	files["C:/Program Files/nodejs/node.exe"] = true
	files["C:/Program Files/GitHub CLI/gh.exe"] = true
	if !win.Found(ToolNode) || !win.Found(ToolGH) {
		t.Fatal("installer folders not looked in")
	}
	mac := ToolFinder{GOOS: "darwin", IsFile: is}
	files["/opt/homebrew/bin/brew"] = true
	if !mac.Found("brew") || mac.Found(ToolGH) {
		t.Fatal("mac")
	}
	lin := ToolFinder{GOOS: "linux", Dirs: []string{"/home/me/bin"}, IsFile: is}
	files["/home/me/bin/gh"] = true
	if !lin.Found(ToolGH) {
		t.Fatal("PATH dir not looked in")
	}
}

func TestGHHostsAndSignIn(t *testing.T) {
	none := func(string) string { return "" }
	if p := GHHosts("windows", `C:\Users\me`, func(k string) string {
		if k == "AppData" {
			return `C:\Users\me\AppData\Roaming`
		}
		return ""
	}); p != filepath.Join(`C:\Users\me\AppData\Roaming`, "GitHub CLI", "hosts.yml") {
		t.Errorf("windows %q", p)
	}
	if p := GHHosts("linux", "/home/me", none); p != filepath.Join("/home/me", ".config", "gh", "hosts.yml") {
		t.Errorf("linux %q", p)
	}
	if p := GHHosts("darwin", "/Users/me", func(k string) string {
		if k == "GH_CONFIG_DIR" {
			return "/x"
		}
		return ""
	}); p != filepath.Join("/x", "hosts.yml") {
		t.Errorf("GH_CONFIG_DIR %q", p)
	}

	dir := t.TempDir()
	hosts := filepath.Join(dir, "hosts.yml")
	if GHSignedIn(hosts, none) {
		t.Fatal("signed in without a file")
	}
	if !GHSignedIn(hosts, func(k string) string {
		if k == "GH_TOKEN" {
			return "x"
		}
		return ""
	}) {
		t.Fatal("GH_TOKEN not counted")
	}
	if err := os.WriteFile(hosts, []byte("ghe.example.com:\n    user: me\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if GHSignedIn(hosts, none) {
		t.Fatal("another host counted as github.com")
	}
	if err := os.WriteFile(hosts, []byte("github.com:\r\n    git_protocol: https\r\n    user: me\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !GHSignedIn(hosts, none) {
		t.Fatal("github.com host not read")
	}
}
