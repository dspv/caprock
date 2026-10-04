package agents

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/dspv/caprock/internal/userenv"
)

// The coding agents Caprock can launch.
const (
	AgentClaude   = "claude"
	AgentGemini   = "gemini"
	AgentCodex    = "codex"
	AgentOpenCode = "opencode"
)

// Spawnable lists the agents Caprock can start, in the order the dialog
// offers them.
var Spawnable = []string{AgentClaude, AgentCodex, AgentOpenCode, AgentGemini}

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
	}
	return dirs
}

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

func envValue(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		if strings.HasPrefix(env[i], key+"=") {
			return env[i][len(key)+1:]
		}
	}
	return ""
}
