// Package fgproc names the program a shell is running in its foreground: what
// a terminal app asks before it closes a tab ("Shell 1 is running claude").
//
// On macOS and Linux the answer is the terminal's foreground process group,
// read from the shell process itself (its tpgid): when that group is not the
// shell's own, a job is in front of the prompt, and the group's leader names
// it. Nothing here opens the terminal or talks to the pty-host; the kernel
// keeps the tpgid on every process of the session. On Windows it is a scan
// for the shell's child processes, best effort: it may name nothing, and it
// never fails.
//
// The name is the program's argv[0] as typed, not the kernel's short name:
// Claude Code's native binary is a file named after its version, so the
// kernel calls it "2.1.289" while argv[0] says "claude".
//
// Callers pass only the pid of a shell Caprock started (rule 7); this package
// reads, it never signals.
package fgproc

import (
	"path/filepath"
	"strings"
)

// Unnamed is what Foreground answers for a job it can see but not name, such
// as a pipeline whose first process has already exited.
const Unnamed = "program"

// Foreground is the name of the program in front of the shell with this pid,
// or "" when the shell is at its prompt, has exited, or the platform cannot
// tell.
func Foreground(shellPID int) string {
	if shellPID <= 1 {
		return ""
	}
	return foreground(shellPID)
}

// progName is a program's display name from its argv[0], else from the
// kernel's name for it: the base name, without a login shell's leading "-"
// or a Windows ".exe".
func progName(argv0, comm string) string {
	n := strings.TrimSpace(argv0)
	if n == "" {
		n = strings.TrimSpace(comm)
	}
	n = strings.TrimPrefix(n, "-")
	if i := strings.LastIndexAny(n, `/\`); i >= 0 {
		n = n[i+1:]
	}
	if ext := filepath.Ext(n); strings.EqualFold(ext, ".exe") {
		n = n[:len(n)-len(ext)]
	}
	if n == "" {
		return Unnamed
	}
	return n
}
