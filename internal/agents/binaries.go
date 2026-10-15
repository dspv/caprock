package agents

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/dspv/caprock/internal/userenv"
)

// The coding agents Caprock can launch.
const (
	AgentClaude   = "claude"
	AgentGemini   = "gemini"
	AgentCodex    = "codex"
	AgentOpenCode = "opencode"
	// AgentGrok is xAI's Grok Build CLI, `grok` (ADR-046).
	AgentGrok = "grok"
	// AgentHermes is Nous Research's Hermes Agent CLI, `hermes` (ADR-069).
	AgentHermes = "hermes"
)

// Spawnable lists the agents Caprock can start, in the order the dialog
// offers them.
var Spawnable = []string{AgentClaude, AgentCodex, AgentOpenCode, AgentGemini, AgentGrok, AgentHermes}

// IsSpawnable reports whether agent names one Caprock can start. "" is Claude
// Code, which every request before the agent field meant.
func IsSpawnable(agent string) bool {
	if agent == "" {
		return true
	}
	for _, a := range Spawnable {
		if a == agent {
			return true
		}
	}
	return false
}

// extraDirs are where each CLI's own installer puts it when that is not a
// directory a bare PATH carries. launchd starts the daemon with
// PATH=/usr/bin:/bin:/usr/sbin:/sbin, so "on PATH" has to mean the user's
// login-shell PATH (internal/userenv) plus these, or every agent installed by
// Homebrew, npm or its own script reads as absent.
func extraDirs(name string) []string {
	home, _ := os.UserHomeDir()
	dirs := []string{
		filepath.Join(home, ".local", "bin"),
		filepath.Join(home, "bin"),
		filepath.Join("/opt", "homebrew", "bin"),
		filepath.Join("/usr", "local", "bin"),
	}
	switch name {
	case AgentClaude:
		dirs = append(dirs, filepath.Join(home, ".claude", "local"))
	case AgentOpenCode:
		// opencode's install script writes here.
		dirs = append(dirs, filepath.Join(home, ".opencode", "bin"))
	case AgentGrok:
		// xAI's install script (x.ai/cli/install.sh) links it here.
		dirs = append(dirs, filepath.Join(home, ".grok", "bin"))
	}
	// npm installs Codex and Gemini CLI (and can install the others) into its
	// global prefix, which a version manager keeps outside every directory
	// above. The login shell's PATH usually carries it; these are for when it
	// does not (a profile that loads nvm lazily, a shell that timed out).
	dirs = append(dirs, filepath.Join(home, ".npm-global", "bin"), filepath.Join(home, ".volta", "bin"), filepath.Join(home, ".bun", "bin"))
	dirs = append(dirs, nvmBins(home)...)
	return dirs
}

// nvmBins are the bin directories of the Node versions nvm installed, newest
// first by name, so a CLI installed with `npm install -g` under any of them is
// found.
func nvmBins(home string) []string {
	root := os.Getenv("NVM_DIR")
	if root == "" {
		root = filepath.Join(home, ".nvm")
	}
	matches, _ := filepath.Glob(filepath.Join(root, "versions", "node", "*", "bin"))
	sort.Sort(sort.Reverse(sort.StringSlice(matches)))
	return matches
}

// FindBinary resolves a command the way an agent's binary is resolved: the
// daemon's PATH, the login shell's, then the installers' directories. "" when
// it is not found. For a custom agent's command (ADR-046).
func FindBinary(name string) string {
	if filepath.IsAbs(name) {
		if isExecutable(name) {
			return name
		}
		return ""
	}
	return findBinaryIn(name, userenv.Cached(), extraDirs(name))
}

// IsBatch reports whether a binary is a Windows .cmd or .bat shim.
func IsBatch(p string) bool { return isBatch(p) }

// FlattenForBatch makes a prompt safe for a Windows batch shim's command line.
func FlattenForBatch(p string) string { return flattenForBatch(p) }

// findBinary resolves an agent's executable to an absolute path, or "" when
// the machine does not have it.
//
// Order: the daemon's own PATH, then the login shell's (only if already
// resolved — this runs on every status poll and must never wait for a shell
// profile), then the installers' directories. The result is absolute because
// the PTY is started from the daemon, whose PATH is not the one that found it.
func findBinary(name string) string {
	return findBinaryIn(name, userenv.Cached(), extraDirs(name))
}

func findBinaryIn(name string, loginEnv []string, extra []string) string {
	if p, err := exec.LookPath(name); err == nil {
		if abs, err := filepath.Abs(p); err == nil {
			return abs
		}
		return p
	}
	var dirs []string
	if path := envValue(loginEnv, "PATH"); path != "" {
		dirs = append(dirs, filepath.SplitList(path)...)
	}
	dirs = append(dirs, extra...)
	for _, dir := range dirs {
		if dir == "" || !filepath.IsAbs(dir) {
			continue
		}
		for _, cand := range candidates(name) {
			p := filepath.Join(dir, cand)
			if isExecutable(p) {
				return p
			}
		}
	}
	return ""
}

// candidates is name on POSIX, and name with each executable extension on
// Windows, where npm installs a CLI as name.cmd beside a name.ps1.
func candidates(name string) []string {
	if runtime.GOOS != "windows" {
		return []string{name}
	}
	exts := strings.Split(strings.ToLower(os.Getenv("PATHEXT")), ";")
	if len(exts) == 0 || exts[0] == "" {
		exts = []string{".com", ".exe", ".bat", ".cmd"}
	}
	out := make([]string, 0, len(exts))
	for _, e := range exts {
		if e != "" {
			out = append(out, name+e)
		}
	}
	return out
}

func isExecutable(p string) bool {
	fi, err := os.Stat(p)
	if err != nil || fi.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return fi.Mode()&0o111 != 0
}

// isBatch reports whether a binary is a Windows batch shim, which runs under
// cmd.exe and so cannot take a multi-line argument intact.
func isBatch(p string) bool {
	ext := strings.ToLower(filepath.Ext(p))
	return ext == ".cmd" || ext == ".bat"
}

func envValue(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		if strings.HasPrefix(env[i], key+"=") {
			return env[i][len(key)+1:]
		}
	}
	return ""
}
