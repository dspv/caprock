package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/readiness"
)

// runShells is a shell controller whose one shell's program and screen the
// test sets, recording what is run and typed. Nothing is started.
type runShells struct {
	started []string
	ran     []string
	keys    []string
	program string
	screen  []string
	gone    bool
}

func (f *runShells) StartShell(_ context.Context, cwd string, _, _ int) (ShellInfo, error) {
	f.started = append(f.started, cwd)
	return ShellInfo{ID: "sh-1", Cwd: cwd, Kind: "shell"}, nil
}
func (f *runShells) Shells() []ShellInfo {
	if f.gone || len(f.started) == 0 {
		return nil
	}
	return []ShellInfo{{ID: "sh-1", Program: f.program}}
}
func (f *runShells) RunAtPrompt(_, text string)                    { f.ran = append(f.ran, text) }
func (f *runShells) ShellScreen(string) ([]string, bool)           { return f.screen, true }
func (f *runShells) ShellKeys(_, text string) error                { f.keys = append(f.keys, text); return nil }
func (f *runShells) TypeAtPrompt(_, text string)                   {}
func (f *runShells) IsShell(id string) bool                        { return id == "sh-1" }
func (f *fakeSetupChrome) EnableChromeDefault() error              { f.chrome = true; return nil }
func (f *fakeSetupChrome) SetAgentSwitch(id string, on bool) error { return nil }

type fakeSetupChrome struct {
	fakeSetup
	chrome bool
}

func winFacts() readiness.Inputs {
	return readiness.Inputs{GOOS: "windows", Git: readiness.Git{Found: true, Fresh: true},
		Agents: []readiness.Agent{{ID: "claude", Label: "Claude Code", Installed: true, SignIn: readiness.Missing, SignInCommand: "claude auth login"}},
		Tools:  &readiness.ToolFacts{GH: true, Claude: true}}
}

func runView(t *testing.T, body []byte) SetupRunView {
	t.Helper()
	var v SetupRunView
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	return v
}

// A step runs this computer's own command for it, in a shell in the home
// folder; a second click while it runs answers the same run; a step with
// nothing to run, or one the caller names a command for, runs nothing.
func TestSetupRunRunsTheChecklistsOwnCommand(t *testing.T) {
	sh := &runShells{}
	fs := &fakeSetupChrome{fakeSetup: fakeSetup{in: winFacts()}}
	s, _, _, _ := pairedPhones(t, Deps{Remote: &fakeRemote{}, Setup: fs, Shells: sh})

	w := serve(s, local("POST", "/v1/setup/run", `{"step":"node","command":"rm -rf /"}`))
	if w.Code != 200 {
		t.Fatalf("node: %d %s", w.Code, w.Body.String())
	}
	if len(sh.ran) != 1 || !strings.HasPrefix(sh.ran[0], "winget install --id OpenJS.NodeJS.LTS") {
		t.Fatalf("ran %q", sh.ran)
	}
	if v := runView(t, w.Body.Bytes()); v.State != "running" || v.Shell != "sh-1" || v.Key != "node" {
		t.Fatalf("view %+v", v)
	}
	sh.program = "winget"
	if w = serve(s, local("POST", "/v1/setup/run", `{"step":"node"}`)); w.Code != 200 || len(sh.ran) != 1 {
		t.Fatalf("second click started another: %d %q", w.Code, sh.ran)
	}
	// The agent's own sign-in, by its row.
	if w = serve(s, local("POST", "/v1/setup/run", `{"step":"agent","agent":"claude"}`)); w.Code != 200 || sh.ran[len(sh.ran)-1] != "claude auth login" {
		t.Fatalf("agent: %d %q", w.Code, sh.ran)
	}
	for _, body := range []string{`{"step":"git"}`, `{"step":"agent","agent":"codex"}`, `{"step":"rm"}`, `{"step":"gh"}`} {
		if w = serve(s, local("POST", "/v1/setup/run", body)); w.Code != http.StatusConflict {
			t.Errorf("%s: %d", body, w.Code)
		}
	}
	if len(sh.ran) != 2 {
		t.Fatalf("ran %q", sh.ran)
	}
}

// A run is running while a program is in front of its shell's prompt, and
// finished once the shell is idle again; its last line is the one above the
// prompt.
func TestSetupRunsFollowTheShell(t *testing.T) {
	sh := &runShells{}
	fs := &fakeSetupChrome{fakeSetup: fakeSetup{in: winFacts()}}
	s, _, _, _ := pairedPhones(t, Deps{Remote: &fakeRemote{}, Setup: fs, Shells: sh})
	runs := func() []SetupRunView {
		var b struct{ Runs []SetupRunView }
		if err := json.Unmarshal(serve(s, local("GET", "/v1/setup/runs", "")).Body.Bytes(), &b); err != nil {
			t.Fatal(err)
		}
		return b.Runs
	}
	if len(runs()) != 0 {
		t.Fatal("runs before any")
	}
	serve(s, local("POST", "/v1/setup/run", `{"step":"node"}`))
	sh.program, sh.screen = "winget", []string{"PS C:\\Users\\me> winget install …", "  ██████  45%", ""}
	if r := runs(); len(r) != 1 || r[0].State != "running" || r[0].Line != "██████  45%" {
		t.Fatalf("running: %+v", r)
	}
	sh.program, sh.screen = "", append(sh.screen[:2], "Successfully installed", "PS C:\\Users\\me>")
	if r := runs(); r[0].State != "finished" || r[0].Line != "Successfully installed" {
		t.Fatalf("finished: %+v", r)
	}
	// Finished stays finished, and a new click starts a new run.
	sh.program = "winget"
	if r := runs(); r[0].State != "finished" {
		t.Fatalf("came back: %+v", r)
	}
	serve(s, local("POST", "/v1/setup/run", `{"step":"node"}`))
	if len(sh.ran) != 2 {
		t.Fatalf("no new run after the first finished: %q", sh.ran)
	}
}

// The GitHub CLI's sign-in: its two questions are answered once each, the
// one-time code is read off the screen, and it is gone once signed in.
func TestSetupRunGitHubDeviceFlow(t *testing.T) {
	sh := &runShells{}
	fs := &fakeSetupChrome{fakeSetup: fakeSetup{in: winFacts()}}
	s, _, _, _ := pairedPhones(t, Deps{Remote: &fakeRemote{}, Setup: fs, Shells: sh})
	if w := serve(s, local("POST", "/v1/setup/run", `{"step":"gh_auth"}`)); w.Code != 200 || sh.ran[0] != readiness.GHLogin {
		t.Fatalf("%d %q", w.Code, sh.ran)
	}
	get := func() SetupRunView {
		var b struct{ Runs []SetupRunView }
		_ = json.Unmarshal(serve(s, local("GET", "/v1/setup/runs", "")).Body.Bytes(), &b)
		return b.Runs[0]
	}
	sh.program = "gh"
	sh.screen = []string{"? Authenticate Git with your GitHub credentials? (Y/n)"}
	get()
	get()
	if len(sh.keys) != 1 {
		t.Fatalf("question answered %d times", len(sh.keys))
	}
	sh.screen = []string{"? Authenticate Git with your GitHub credentials? Yes", "! First copy your one-time code: AB12-CD34", "Press Enter to open github.com in your browser..."}
	if v := get(); v.Code != "AB12-CD34" {
		t.Fatalf("code %+v", v)
	}
	get()
	if len(sh.keys) != 2 {
		t.Fatalf("keys %q", sh.keys)
	}
	sh.screen = append(sh.screen, "✓ Authentication complete.", "✓ Logged in as me")
	if v := get(); v.Code != "" {
		t.Fatalf("code kept after the sign-in: %+v", v)
	}
}

// Chrome's setting is written by the daemon, not a command, and answers the
// checklist.
func TestSetupRunChromeDefault(t *testing.T) {
	fs := &fakeSetupChrome{fakeSetup: fakeSetup{in: winFacts()}}
	s, _, _, _ := pairedPhones(t, Deps{Remote: &fakeRemote{}, Setup: fs, Shells: &runShells{}})
	w := serve(s, local("POST", "/v1/setup/run", `{"step":"chrome_default"}`))
	if w.Code != 200 || !fs.chrome || !strings.Contains(w.Body.String(), `"tools"`) {
		t.Fatalf("%d %v %s", w.Code, fs.chrome, w.Body.String())
	}
}

// A linked laptop may run steps here and read the runs; a phone may not.
func TestSetupRunFromDevices(t *testing.T) {
	sh := &runShells{}
	fs := &fakeSetupChrome{fakeSetup: fakeSetup{in: winFacts()}}
	s, ps, viewer, controller := pairedPhones(t, Deps{Remote: &fakeRemote{}, Setup: fs, Shells: sh})
	laptop := pairedComputer(t, ps, "MacBook", true)
	if w := serve(s, fromDevice("POST", "/v1/setup/run", `{"step":"node"}`, laptop.Token)); w.Code != 200 {
		t.Fatalf("laptop: %d %s", w.Code, w.Body.String())
	}
	if w := serve(s, fromDevice("GET", "/v1/setup/runs", "", laptop.Token)); w.Code != 200 {
		t.Fatalf("laptop runs: %d", w.Code)
	}
	for _, tok := range []string{viewer.Token, controller.Token} {
		if w := serve(s, fromDevice("POST", "/v1/setup/run", `{"step":"gh_auth"}`, tok)); w.Code != 403 {
			t.Errorf("phone: %d", w.Code)
		}
	}

}
