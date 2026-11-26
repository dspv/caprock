package readiness

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// Tools are the steps past "can run agents" that the owner walked to his
// Windows PC for on 2026-11-26 (issue #1088): Node.js and the GitHub CLI
// installed, the GitHub CLI signed in, Claude Code's one-time bypass warning
// accepted, and Claude in Chrome on by default. None of them keeps a computer
// from being ready, so they are not items: a reader from before them (an older
// laptop, this computer's own checklist, `caprock setup`) sees exactly what it
// saw. The laptop's *Set up this computer* (the computer's page) lists them,
// and runs each one there on a click (POST /v1/setup/run).

// The tools, in the order the laptop lists them.
const (
	ToolNode = "node"
	ToolGH   = "gh"
	// ToolGHAuth is the GitHub CLI's sign-in, by device flow: the code is
	// shown on the laptop (GET /v1/setup/runs).
	ToolGHAuth = "gh_auth"
	// ToolBypass is Claude Code's one-time bypass warning, accepted with
	// POST /v1/claude/bypass-consent (ADR-041).
	ToolBypass = "bypass"
	// ToolChrome is Claude in Chrome's "Enabled by default" (`/chrome` in
	// Claude Code): claudeInChromeDefaultEnabled in its global config.
	ToolChrome = "chrome_default"
)

// Tool is one of them, as GET /v1/setup sends it under `tools`.
type Tool struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	State  string `json:"state"`
	Detail string `json:"detail"`
	// Command is what POST /v1/setup/run types and runs in a shell tab
	// there; "" when there is no one command (no Homebrew, Linux), or the
	// step is not a command (the bypass warning, Chrome's setting).
	Command string `json:"command,omitempty"`
}

// ToolFacts are what the daemon found for the tools.
type ToolFacts struct {
	Node bool
	GH   bool
	// GHSignedIn: the GitHub CLI holds a sign-in for github.com (GHHosts).
	GHSignedIn bool
	// Brew: Homebrew is installed (macOS), so `brew install` is the command.
	Brew bool
	// Claude: Claude Code is installed here; the bypass and Chrome rows are
	// about it, and absent without it.
	Claude bool
	// Bypass: its bypass warning is accepted (hooks.BypassAccepted).
	Bypass bool
	// Chrome: claudeInChromeDefaultEnabled is true (hooks.ChromeDefault).
	Chrome bool
}

// The winget packages: the ids in the winget-pkgs repository
// (manifests/o/OpenJS/NodeJS/LTS, manifests/g/GitHub/cli, read 2026-11-26).
// The two --accept flags answer winget's first-run agreement prompt, which
// would otherwise wait for a Y nobody at that computer types.
const (
	wingetNode = "winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements"
	wingetGH   = "winget install --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements"
)

// GHLogin signs the GitHub CLI in by device flow: --web asks for no token,
// --hostname and --git-protocol skip the two questions they answer. gh then
// asks whether Git should use the sign-in (yes is its default) and waits for
// Enter before opening a browser; the run answers both (api, setup runs).
const GHLogin = "gh auth login --web --hostname github.com --git-protocol https"

// ToolInstall is the command that installs tool id here, "" where there is no
// single one.
func ToolInstall(goos, id string, brew bool) string {
	switch goos {
	case "windows":
		switch id {
		case ToolNode:
			return wingetNode
		case ToolGH:
			return wingetGH
		}
	case "darwin":
		if !brew {
			return ""
		}
		switch id {
		case ToolNode:
			return "brew install node"
		case ToolGH:
			return "brew install gh"
		}
	}
	return ""
}

// BuildTools words the tools.
func BuildTools(goos string, f ToolFacts) []Tool {
	out := []Tool{
		installTool(goos, ToolNode, "Node.js", f.Node, f.Brew,
			"npm and the agents installed with it use it.",
			"sudo apt install nodejs npm (Debian, Ubuntu), sudo dnf install nodejs (Fedora), sudo pacman -S nodejs npm (Arch)"),
		installTool(goos, ToolGH, "GitHub CLI", f.GH, f.Brew,
			"Agents open pull requests and read CI with it.",
			"sudo apt install gh (Debian, Ubuntu), sudo dnf install gh (Fedora), sudo pacman -S github-cli (Arch)"),
	}
	auth := Tool{ID: ToolGHAuth, Label: "Sign in to GitHub"}
	switch {
	case f.GHSignedIn:
		auth.State, auth.Detail = OK, "Signed in."
	case !f.GH:
		auth.State, auth.Detail = Missing, "Install the GitHub CLI first."
	default:
		auth.State, auth.Command = Missing, GHLogin
		auth.Detail = "By a one-time code you enter on GitHub from this computer; Git there uses the same sign-in."
	}
	out = append(out, auth)
	if !f.Claude {
		return out
	}
	by := Tool{ID: ToolBypass, Label: "Bypass warning"}
	if f.Bypass {
		by.State, by.Detail = OK, "Accepted."
	} else {
		by.State, by.Detail = Missing, "Claude Code asks once before its first session in Bypass; accept it here so a start from this computer is not stopped there."
	}
	ch := Tool{ID: ToolChrome, Label: "Claude in Chrome on by default"}
	if f.Chrome {
		ch.State, ch.Detail = OK, "On: sessions there connect to Chrome when they start."
	} else {
		ch.State, ch.Detail = Missing, "Claude Code's /chrome setting \"Enabled by default\": sessions there connect to Chrome when they start."
	}
	return append(out, by, ch)
}

func installTool(goos, id, label string, found, brew bool, why, linux string) Tool {
	t := Tool{ID: id, Label: label}
	if found {
		t.State, t.Detail = OK, "Installed."
		return t
	}
	t.State, t.Command = Missing, ToolInstall(goos, id, brew)
	switch {
	case goos == "windows":
		t.Detail = why + " Install runs winget there; Windows may ask for an administrator on that PC's own screen."
	case goos == "darwin" && brew:
		t.Detail = why + " Install runs Homebrew there."
	case goos == "darwin":
		t.Detail = why + " Install Homebrew there first (brew.sh), then it installs from here."
	default:
		t.Detail = why + " Install it there with the package manager: " + linux + "."
	}
	return t
}

// ToolFinder looks for a program without running it, on the user's PATH as
// it is now and in its installers' own folders (GitFinder's way).
type ToolFinder struct {
	GOOS string
	Dirs []string
	Env  func(string) string
	// IsFile reports whether a path is a regular file. Swapped by tests.
	IsFile func(string) bool
}

// Found reports whether tool id (ToolNode, ToolGH, "brew") is installed.
func (f ToolFinder) Found(id string) bool {
	isFile := f.IsFile
	if isFile == nil {
		isFile = regularFile
	}
	env := f.Env
	if env == nil {
		env = os.Getenv
	}
	bin := id
	if id == ToolNode {
		bin = "node"
	}
	names := []string{bin}
	dirs := append([]string(nil), f.Dirs...)
	switch f.GOOS {
	case "windows":
		names = []string{bin + ".exe", bin + ".cmd"}
		var sub []string
		switch id {
		case ToolNode:
			sub = []string{"nodejs"}
		case ToolGH:
			sub = []string{"GitHub CLI"}
		}
		for _, base := range []string{env("ProgramFiles"), env("ProgramW6432"), env("ProgramFiles(x86)")} {
			for _, s := range sub {
				if base != "" {
					dirs = append(dirs, filepath.Join(base, s))
				}
			}
		}
		if la := env("LOCALAPPDATA"); la != "" {
			for _, s := range sub {
				dirs = append(dirs, filepath.Join(la, "Programs", s))
			}
		}
	case "darwin":
		dirs = append(dirs, "/opt/homebrew/bin", "/usr/local/bin")
	default:
		dirs = append(dirs, "/usr/bin", "/usr/local/bin", "/bin")
	}
	for _, d := range dirs {
		if d == "" {
			continue
		}
		for _, n := range names {
			if isFile(filepath.Join(d, n)) {
				return true
			}
		}
	}
	return false
}

// GHHosts is the GitHub CLI's hosts.yml, where it records a signed-in host:
// $GH_CONFIG_DIR, else $XDG_CONFIG_HOME/gh, else %AppData%\GitHub CLI on
// Windows, else ~/.config/gh (`gh help environment`, GH_CONFIG_DIR).
func GHHosts(goos, home string, getenv func(string) string) string {
	if d := getenv("GH_CONFIG_DIR"); d != "" {
		return filepath.Join(d, "hosts.yml")
	}
	if d := getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "gh", "hosts.yml")
	}
	if goos == "windows" {
		if d := getenv("AppData"); d != "" {
			return filepath.Join(d, "GitHub CLI", "hosts.yml")
		}
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".config", "gh", "hosts.yml")
}

// GHSignedIn reports whether the GitHub CLI holds a sign-in for github.com:
// a token in the environment it reads (GH_TOKEN, GITHUB_TOKEN), or a
// `github.com:` host in hosts.yml. Presence only, as ADR-099 reads every
// sign-in: the line naming the host is all that is looked at, never a token
// (gh keeps one in the system keyring, or in that file under the host).
func GHSignedIn(hostsPath string, getenv func(string) string) bool {
	if getenv("GH_TOKEN") != "" || getenv("GITHUB_TOKEN") != "" {
		return true
	}
	if hostsPath == "" {
		return false
	}
	f, err := os.Open(hostsPath)
	if err != nil {
		return false
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.TrimRight(sc.Text(), " \t\r") == "github.com:" {
			return true
		}
	}
	return false
}
