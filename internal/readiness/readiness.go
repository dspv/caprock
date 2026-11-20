// Package readiness answers "can this computer run agents yet, and if not,
// what is the next step?" — the setup checklist of Settings → Computers, Home,
// `caprock setup`, and the readiness a linked laptop reads through
// `/v1/m/{id}/v1/setup` (GET /v1/setup, ADR-099).
//
// The owner's first two-computer test (a MacBook driving a Windows PC,
// 2026-11-20) found a PC without Git and Claude Code that nothing on either
// screen mentioned, and a laptop that showed the PC linked without saying
// whether it could do anything. Five items cover the path from a fresh
// install to "start agents from your laptop": Git, an agent, its sign-in, a
// project, the link. Each says in a sentence what to do, and the installs and
// sign-ins carry the command that does it — typed into a shell tab for the
// user to run, never run by Caprock (ADR-046).
//
// Build is pure: the daemon gathers the facts (files, PATH, the pairing
// state) and Build words them, so every wording is tested on every OS.
package readiness

import (
	"fmt"
	"strings"
)

// The states of an item.
const (
	// OK: done.
	OK = "ok"
	// Missing: not done; Detail says what to do, Command does it when there
	// is one command for it.
	Missing = "missing"
	// Unknown: Caprock cannot tell from what it may read (Codex keeping its
	// sign-in in the system keyring). Offered, never ticked.
	Unknown = "unknown"
	// NotNeeded: does not apply on this computer. A client treats it as done.
	NotNeeded = "not_needed"
)

// The items, in the checklist's order.
const (
	KeyGit     = "git"
	KeyAgent   = "agent"
	KeySignIn  = "signin"
	KeyProject = "project"
	KeyLink    = "link"
)

// Item is one line of the checklist.
type Item struct {
	Key    string `json:"key"`
	State  string `json:"state"`
	Label  string `json:"label"`
	Detail string `json:"detail"`
	// Command fixes it in a terminal: typed into a shell tab, or printed by
	// `caprock setup`, never run by Caprock. The link's is a caprock command
	// for a computer reached over SSH; its screen has its own buttons.
	Command string `json:"command,omitempty"`
}

// Report is GET /v1/setup.
type Report struct {
	OS    string `json:"os"`
	Items []Item `json:"items"`
}

// Ready reports whether nothing is left to do.
func (r Report) Ready() bool {
	for _, it := range r.Items {
		if it.State != OK && it.State != NotNeeded {
			return false
		}
	}
	return true
}

// Git is what was found of Git.
type Git struct {
	Found bool
	// Fresh is false when the user's current PATH could not be read, so a Git
	// installed after Caprock started may not be seen until it restarts.
	Fresh bool
}

// Agent is one agent that can run here: Claude Code or Codex.
type Agent struct {
	ID        string // "claude", "codex"
	Label     string // "Claude Code", "Codex"
	Installed bool
	// Install is the catalog's install command (ADR-046).
	Install string
	// SignIn is OK, Missing or Unknown.
	SignIn string
	// SignInCommand is the agent's own sign-in.
	SignInCommand string
}

// Link is how this computer stands with the computers that reach it.
type Link struct {
	// Supported is false in a build that cannot be reached through a relay.
	Supported bool
	// On: access from anywhere is on.
	On bool
	// Allowed are the computers allowed here, by name; Waiting those that
	// redeemed a link and wait for Allow.
	Allowed []string
	Waiting []string
}

// Inputs are the facts Build words.
type Inputs struct {
	GOOS     string
	Git      Git
	Agents   []Agent
	Projects int
	Link     Link
}

// Build words the checklist.
func Build(in Inputs) Report {
	r := Report{OS: in.GOOS}
	r.Items = append(r.Items, gitItem(in.GOOS, in.Git), agentItem(in.Agents), signInItem(in.Agents), projectItem(in.Projects), linkItem(in.Link))
	return r
}

// GitInstall is the command that installs Git, "" where there is no single
// one (Linux: the distribution's package manager).
//
//   - Windows: winget's Git for Windows package (Git.Git), the install
//     Claude Code's setup page points at (code.claude.com/docs/en/setup,
//     read 2026-11-20). It asks for an administrator once.
//   - macOS: the Command Line Tools, which carry Git; macOS opens its own
//     installer window.
func GitInstall(goos string) string {
	switch goos {
	case "windows":
		return "winget install --id Git.Git -e --source winget"
	case "darwin":
		return "xcode-select --install"
	}
	return ""
}

func gitItem(goos string, g Git) Item {
	it := Item{Key: KeyGit, Label: "Git"}
	if g.Found {
		it.State, it.Detail = OK, "Installed."
		return it
	}
	it.State, it.Command = Missing, GitInstall(goos)
	switch goos {
	case "windows":
		it.Detail = "Claude Code needs it on Windows. Install runs winget in a terminal; Windows asks once for an administrator."
	case "darwin":
		it.Detail = "Agents use it for your repositories. Install opens Apple's installer for the Command Line Tools, which carry Git."
	default:
		it.Detail = "Agents use it for your repositories. Install it with your package manager: sudo apt install git (Debian, Ubuntu), sudo dnf install git (Fedora), sudo pacman -S git (Arch)."
	}
	if !g.Fresh {
		it.Detail += " Installed it already? Restart Caprock to see it."
	}
	return it
}

func agentItem(agents []Agent) Item {
	it := Item{Key: KeyAgent, Label: "Claude Code or Codex"}
	var have []string
	for _, a := range agents {
		if a.Installed {
			have = append(have, a.Label)
		}
	}
	if len(have) > 0 {
		it.State, it.Label, it.Detail = OK, strings.Join(have, " and "), "Installed."
		return it
	}
	it.State = Missing
	it.Detail = "No agent is installed here yet. Install Claude Code, or Codex — at least one."
	for _, a := range agents {
		if a.Install != "" {
			it.Command = a.Install
			it.Detail = fmt.Sprintf("No agent is installed here yet. Install %s (or Codex — at least one agent).", a.Label)
			break
		}
	}
	return it
}

func signInItem(agents []Agent) Item {
	it := Item{Key: KeySignIn, Label: "Sign in"}
	var installed []Agent
	for _, a := range agents {
		if a.Installed {
			installed = append(installed, a)
		}
	}
	if len(installed) == 0 {
		it.State, it.Detail = Missing, "Install an agent first, then sign in to your subscription."
		return it
	}
	for _, a := range installed {
		if a.SignIn == OK {
			it.State, it.Label, it.Detail = OK, "Signed in to "+a.Label, "Ready to work."
			return it
		}
	}
	a := installed[0]
	for _, b := range installed {
		if b.SignIn == Missing {
			a = b
			break
		}
	}
	it.Label, it.Command = "Sign in to "+a.Label, a.SignInCommand
	if a.SignIn == Missing {
		it.State, it.Detail = Missing, "Sign in to your subscription: the browser opens, then come back here."
		return it
	}
	it.State = Unknown
	it.Detail = fmt.Sprintf("Caprock cannot tell whether %s is signed in: it may keep its sign-in in the system keyring. If it is not, it asks on its first start, or sign in now.", a.Label)
	return it
}

func projectItem(n int) Item {
	it := Item{Key: KeyProject, Label: "A project to work in"}
	if n > 0 {
		it.State = OK
		if n == 1 {
			it.Detail = "1 project."
		} else {
			it.Detail = fmt.Sprintf("%d projects.", n)
		}
		return it
	}
	it.State = Missing
	it.Detail = "Clone a repository or pick a folder. Over SSH: git clone it here, then pick its folder in New agent on your laptop; it becomes a project when an agent runs there."
	return it
}

func linkItem(l Link) Item {
	it := Item{Key: KeyLink, Label: "Link to your laptop"}
	switch {
	case !l.Supported:
		it.State, it.Detail = Missing, "This Caprock cannot be reached from another computer. Update Caprock here."
	case len(l.Allowed) > 0 && l.On:
		it.State, it.Detail = OK, joinNames(l.Allowed)+" can start agents here."
	case len(l.Waiting) > 0:
		it.State = Missing
		it.Detail = fmt.Sprintf("%s is waiting: press Allow in Settings → Computers, or run the command here.", l.Waiting[0])
		it.Command = fmt.Sprintf("caprock machines allow %q", l.Waiting[0])
	case len(l.Allowed) > 0:
		it.State, it.Detail, it.Command = Missing, "Access from anywhere is off, so "+joinNames(l.Allowed)+" cannot reach this computer. Turn it on in Settings → Computers, or run the command here.", "caprock remote on"
	default:
		it.State, it.Detail, it.Command = Missing, "Show this computer's link, enter it on your laptop, then allow the laptop here by name.", "caprock setup --link"
	}
	return it
}

func joinNames(ns []string) string {
	switch len(ns) {
	case 0:
		return ""
	case 1:
		return ns[0]
	}
	return strings.Join(ns[:len(ns)-1], ", ") + " and " + ns[len(ns)-1]
}
