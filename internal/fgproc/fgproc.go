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
	name, _ := Job(shellPID)
	return name
}

// Job is Foreground with the job it names: on macOS and Linux the terminal's
// foreground process group, on Windows the shell's child process; 0 with the
// name "". InJob answers whether a process belongs to it — how the daemon
// tells that the job in front of a shell's prompt is a session it observes
// ("claude --resume …" typed into a shell tab, owner, 2026-11-20).
func Job(shellPID int) (name string, job int) {
	if shellPID <= 1 {
		return "", 0
	}
	return foreground(shellPID)
}

// InJob reports whether the process pid belongs to job, as Job returned it:
// its process group is the job's (macOS, Linux), or the job is the process
// or one of its parents (Windows). False when either is unknown or gone.
func InJob(pid, job int) bool {
	if pid <= 1 || job <= 1 {
		return false
	}
	return inJob(pid, job)
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

// proc is one entry of a process table scan, for the child scan Windows uses.
type proc struct {
	pid, ppid int
	exe       string
	start     int64 // creation time, any monotonic unit shared with the shell's
}

// childName names the first real child of the shell in procs: its parent pid
// is the shell's and it started no earlier than the shell did. An older
// process naming the shell's pid as its parent is the orphan of an earlier
// process that held the pid, not the shell's child. Console hosts are
// skipped: they belong to the console, not to what the user ran.
func childName(shellPID int, shellStart int64, procs []proc) string {
	name, _ := childJob(shellPID, shellStart, procs)
	return name
}

// childJob is childName with the child's pid.
func childJob(shellPID int, shellStart int64, procs []proc) (string, int) {
	for _, p := range procs {
		if p.ppid != shellPID || p.pid == shellPID || p.start < shellStart {
			continue
		}
		name := progName(p.exe, "")
		switch strings.ToLower(name) {
		case "conhost", "openconsole":
			continue
		}
		return name, p.pid
	}
	return "", 0
}

// parentChain reports whether job is pid or one of its first few parents in
// procs, each parent older than its child: a stale parent pid (Windows never
// clears one) belongs to a stranger, not a parent.
func parentChain(pid, job int, procs []proc) bool {
	by := make(map[int]proc, len(procs))
	for _, p := range procs {
		by[p.pid] = p
	}
	cur, ok := by[pid]
	for hops := 0; ok && hops < 8; hops++ {
		if cur.pid == job {
			return true
		}
		parent, found := by[cur.ppid]
		if !found || parent.pid == cur.pid || parent.start > cur.start {
			return false
		}
		cur = parent
	}
	return false
}
