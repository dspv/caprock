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
	KeyGit   = "git"
	KeyAgent = "agent"
	// KeySignIn was the sign-in's own item until the agents became
	// switches (owner, 2026-11-20): each agent's row carries its sign-in now,
	// and the item is no longer sent.
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
	// Action says what Command does when it is not an install or a sign-in:
	// ActionPath adds the agent's folder to the user's PATH. The button reads
	// after it ("Add to PATH").
	Action string `json:"action,omitempty"`
	// Optional marks an item that never counts as a step left: the
	// project. Its state is ok or not_needed, so a reader from before the
	// field treats it as done too.
	Optional bool `json:"optional,omitempty"`
}

// ActionPath: the agent item's command adds ~/.local/bin to the user's PATH.
const ActionPath = "path"

// Report is GET /v1/setup.
type Report struct {
	OS    string `json:"os"`
	Items []Item `json:"items"`
	// Agents are the agent item's rows: every agent Caprock can start that
	// has a way to be installed here, or is installed, each with its switch.
	Agents []AgentRow `json:"agents,omitempty"`
}

// The steps an agent's row can be at.
const (
	StepInstall = "install"
	StepPath    = "path"
	StepSignIn  = "signin"
)

// AgentRow is one agent under the agent item: switched on or off, its own
// state, and its one next step.
type AgentRow struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// On is the switch: an agent switched off is grey, not counted, and
	// its state is not_needed. Switching changes nothing but the setting.
	On     bool   `json:"on"`
	State  string `json:"state"`
	Detail string `json:"detail"`
	// Step is install, path or signin while one is left; Command does it.
	Step    string `json:"step,omitempty"`
	Command string `json:"command,omitempty"`
	Action  string `json:"action,omitempty"`
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

// Agent is one agent that can run here: Claude Code, Codex, OpenCode,
// Gemini CLI, Cursor, … — every built-in the catalog can install.
type Agent struct {
	ID    string // "claude", "codex"
	Label string // "Claude Code", "Codex"
	// On is its switch, as AgentOn resolves it.
	On        bool
	Installed bool
	// Install is the catalog's install command (ADR-046).
	Install string
	// SignIn is OK, Missing or Unknown.
	SignIn string
	// SignInCommand is the agent's own sign-in.
	SignInCommand string
	// SignInText says what is missing in the agent's own words, for an
	// agent whose sign-in is not a subscription file (OpenCode's provider).
	SignInText string
	// OffPath is the folder the agent was found in when a terminal opened
	// now cannot find it there: installed, but not on the user's PATH
	// (OffPathDir). "" when it is on the PATH, or the PATH could not be read.
	OffPath string
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
	// Shell is the login shell's name ("zsh", "bash", "fish"): which file
	// PathFix adds to on macOS and Linux.
	Shell string
	// CloneDir is where the Add project sheet clones by default — the folder
	// set as default, else ~/dev — in full, so the project item says where.
	CloneDir string
}

// Build words the checklist.
func Build(in Inputs) Report {
	r := Report{OS: in.GOOS}
	for _, a := range in.Agents {
		r.Agents = append(r.Agents, agentRow(in.GOOS, in.Shell, a))
	}
	// The project is last and optional: agents run in any folder picked in
	// New agent, so a computer is ready without one (owner, 2026-11-20).
	r.Items = append(r.Items, gitItem(in.GOOS, in.Git), agentItem(in.Agents, r.Agents), linkItem(in.Link), projectItem(in.Projects, in.CloneDir))
	return r
}

// AgentOn is an agent's switch: the user's choice when there is one (kept in
// the daemon's settings), else on when it is installed, and Claude Code on
// on a fresh computer; the rest off.
func AgentOn(id string, installed bool, chosen map[string]bool) bool {
	if on, ok := chosen[id]; ok {
		return on
	}
	return installed || id == "claude"
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

// agentRow is one agent's state and next step.
func agentRow(goos, shell string, a Agent) AgentRow {
	row := AgentRow{ID: a.ID, Label: a.Label, On: a.On}
	switch {
	case !a.On:
		row.State, row.Detail = NotNeeded, "Off. Switch it on to set it up here."
	case !a.Installed:
		row.State, row.Step, row.Command = Missing, StepInstall, a.Install
		row.Detail = "Install it, then sign in."
	case a.OffPath != "":
		// Installed where Caprock finds it, but not where a terminal looks:
		// Claude Code's own installer on Windows says so in a sentence the
		// owner could not act on (2026-11-20), and the sign-in is typed in a
		// terminal.
		row.State, row.Step, row.Action, row.Command = Missing, StepPath, ActionPath, PathFix(goos, shell)
		row.Detail = fmt.Sprintf("Installed, but terminals can't find it. Add %s to your PATH so `%s` works in a terminal.", a.OffPath, a.ID)
	case a.SignIn == Missing:
		row.State, row.Step, row.Command = Missing, StepSignIn, a.SignInCommand
		row.Detail = "Installed, not signed in. Sign in to your subscription: the browser opens, then come back here."
		if a.SignInText != "" {
			row.Detail = "Installed. " + a.SignInText
		}
	case a.SignIn == Unknown:
		row.State, row.Step, row.Command = Unknown, StepSignIn, a.SignInCommand
		row.Detail = "Installed. Caprock cannot tell whether it is signed in: it may keep its sign-in in the system keyring. If it is not, it asks on its first start."
	default:
		row.State, row.Detail = OK, "Signed in. Ready."
	}
	return row
}

// agentItem sums the rows up: ok when at least one agent is switched on,
// none switched on is left to install, put on the PATH or sign in, and at
// least one is ready. One whose sign-in Caprock cannot read (unknown) holds
// nothing up beside a ready one. The item keeps the key `agent`, and its
// detail and command are the first step left, so a reader from before the
// rows (an older laptop, `caprock setup`) still says what to do.
func agentItem(agents []Agent, rows []AgentRow) Item {
	it := Item{Key: KeyAgent, Label: "Agents"}
	var on, ready []string
	for i, r := range rows {
		if !r.On {
			continue
		}
		on = append(on, r.Label)
		if r.State == OK {
			ready = append(ready, r.Label)
		}
		if r.State != Missing {
			continue
		}
		it.State, it.Command, it.Action = Missing, r.Command, r.Action
		switch r.Step {
		case StepInstall:
			it.Detail = fmt.Sprintf("Install %s, then sign in.", r.Label)
		case StepPath:
			it.Detail = fmt.Sprintf("%s is installed, but terminals can't find it. Add %s to your PATH so `%s` works in a terminal.", r.Label, agents[i].OffPath, r.ID)
		default:
			it.Detail = fmt.Sprintf("Sign in to %s: the browser opens, then come back here.", r.Label)
		}
		return it
	}
	switch {
	case len(on) == 0:
		it.State, it.Detail = Missing, "Switch on at least one agent you want to run here."
	case len(ready) == 0:
		// Every one switched on is installed, and none can be told signed in.
		it.State = Unknown
		for _, r := range rows {
			if r.On {
				it.Command = r.Command
				it.Detail = fmt.Sprintf("Caprock cannot tell whether %s is signed in: it may keep its sign-in in the system keyring. If it is not, it asks on its first start, or sign in now.", r.Label)
				break
			}
		}
	default:
		it.State, it.Detail = OK, joinNames(ready)+" ready."
	}
	return it
}

// projectItem is optional: agents start in any folder picked in New agent,
// so it never counts as a step left (owner, 2026-11-20). not_needed while
// there is none, which a reader from before `optional` treats as done.
func projectItem(n int, cloneDir string) Item {
	it := Item{Key: KeyProject, Label: "Projects here", Optional: true}
	if n > 0 {
		it.State = OK
		if n == 1 {
			it.Detail = "1 project."
		} else {
			it.Detail = fmt.Sprintf("%d projects.", n)
		}
		return it
	}
	it.State = NotNeeded
	where := "here"
	if cloneDir != "" {
		where = "here into " + cloneDir
	}
	it.Detail = "Optional. Clone a repository " + where + ", or from New agent on your laptop."
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
