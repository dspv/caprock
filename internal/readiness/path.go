package readiness

import (
	"path/filepath"
	"strings"
)

// An agent installed where Caprock looks but a terminal does not.
//
// Claude Code's native installer puts `claude` in ~/.local/bin. On the
// owner's Windows PC (2026-11-20) that folder was not on the user's PATH, and
// the installer ended with "Native installation exists but
// C:\Users\dima\.local\bin is not in your PATH. Add it by opening: System
// Properties → Environment Variables → …", which he could not act on.
// Caprock itself found the binary (agents.resolveClaude checks
// ~/.local/bin), so the agent read as installed while his own terminals, and
// Caprock's shell tabs where the sign-in is typed, could not run it.

// LocalBin is the folder the agents' native installers use, under home.
var LocalBin = filepath.Join(".local", "bin")

// OffPath finds an agent installed in a well-known folder that is not on the
// PATH a terminal gets.
type OffPath struct {
	GOOS string
	Home string
	// Dirs is the PATH a terminal opened now gets (userenv.TerminalPath),
	// split.
	Dirs []string
	// IsFile reports whether a path is a regular file. Swapped by tests.
	IsFile func(string) bool
}

// Dir is the folder holding bin ("claude", "codex") when a terminal cannot
// find it: bin is in ~/.local/bin, that folder is not on the PATH, and no
// folder on the PATH has bin either. "" otherwise.
func (o OffPath) Dir(bin string) string {
	if o.Home == "" || bin == "" {
		return ""
	}
	isFile := o.IsFile
	if isFile == nil {
		isFile = regularFile
	}
	names := []string{bin}
	if o.GOOS == "windows" {
		names = []string{bin + ".exe", bin + ".cmd"}
	}
	has := func(dir string) bool {
		for _, n := range names {
			if isFile(filepath.Join(dir, n)) {
				return true
			}
		}
		return false
	}
	local := filepath.Join(o.Home, LocalBin)
	if !has(local) {
		return ""
	}
	key := func(d string) string {
		d = strings.TrimRight(d, `/\`)
		if o.GOOS == "windows" {
			d = strings.ToLower(strings.ReplaceAll(d, "/", `\`))
		}
		return d
	}
	for _, d := range o.Dirs {
		if key(d) == key(local) || has(d) {
			return ""
		}
	}
	return local
}

// PathFix adds ~/.local/bin to the user's PATH for terminals opened from now
// on, and does nothing when it is there already. Typed into a shell tab and
// run by the user's Enter, never by Caprock (ADR-046).
//
//   - Windows: the user's Path only (never the system's, which needs an
//     administrator), through .NET, which also tells Windows the environment
//     changed so terminals started afterwards see it. PowerShell, the shell
//     tab's shell there; an empty user Path is handled.
//   - macOS and Linux: one export line appended to the login shell's file —
//     ~/.zshrc for zsh, ~/.bash_profile for bash on macOS, ~/.bashrc for bash
//     elsewhere, ~/.profile for anything else — only when that exact line is
//     not there yet; fish has its own idempotent fish_add_path.
func PathFix(goos, shell string) string {
	if goos == "windows" {
		return `$d="$env:USERPROFILE\.local\bin"; $p=[Environment]::GetEnvironmentVariable('Path','User'); if (("$p" -split ';') -notcontains $d) { [Environment]::SetEnvironmentVariable('Path', ((@("$p" -split ';' | Where-Object { $_ }) + $d) -join ';'), 'User') }`
	}
	if shell == "fish" {
		return "fish_add_path -U $HOME/.local/bin"
	}
	rc := "~/.profile"
	switch shell {
	case "zsh":
		rc = "~/.zshrc"
	case "bash":
		rc = "~/.bashrc"
		if goos == "darwin" {
			rc = "~/.bash_profile"
		}
	}
	line := `export PATH="$HOME/.local/bin:$PATH"`
	return "grep -qsxF '" + line + "' " + rc + " || echo '" + line + "' >> " + rc
}
