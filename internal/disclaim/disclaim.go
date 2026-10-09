// Package disclaim makes the programs Caprock starts for the user answer for
// themselves to macOS privacy prompts.
//
// macOS asks before a process reads the Desktop, Documents, Downloads, the
// Music library, a network volume and a few other places, and it names the
// process's "responsible" program in the prompt: the app that started it, all
// the way down the tree. Every agent and shell Caprock starts is a child of the
// daemon or its pty-host, so a `find /` an agent ran inside a session asked
// "caprock" for the Music library and network volumes (2026-10-09, tccd log).
// The binary is ad-hoc signed, a new program to macOS on each release, so the
// prompt came back after every upgrade, and an answer given to "caprock"
// covered nothing the user would recognise.
//
// Terminal-like apps solve this by disclaiming responsibility when they start
// a child: iTerm2 and Chromium pass responsibility_spawnattrs_setdisclaim to
// posix_spawn. Go's os/exec forks, so the attribute cannot be set there.
// Instead Wrap rewrites a command to run through Caprock's own binary, which
// re-executes the real program with posix_spawn(POSIX_SPAWN_SETEXEC) and the
// disclaim attribute: same pid, same file descriptors, same session and
// controlling terminal, and the program becomes responsible for itself.
//
// Everywhere but macOS, and wherever the binary did not call Enable (tests,
// other entry points), Wrap returns the command unchanged.
package disclaim

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
)

// Arg is the hidden first argument that turns the caprock binary into the
// re-exec trampoline: caprock Arg <path> <argv0> [args...].
const Arg = "__disclaim-exec"

var (
	mu   sync.RWMutex
	self string
)

// Enable turns wrapping on for this process. Only a binary whose main calls
// Main first may call it, since Wrap points commands back at this executable.
// A no-op off macOS or when the executable cannot be found.
func Enable() {
	if !supported {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		return
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	mu.Lock()
	self = exe
	mu.Unlock()
}

// EnableWith is Enable with the binary named: exe must call Main first, as
// a test binary's TestMain can. It returns a function that restores the
// previous setting.
func EnableWith(exe string) (restore func()) {
	mu.Lock()
	prev := self
	self = exe
	mu.Unlock()
	return func() { mu.Lock(); self = prev; mu.Unlock() }
}

// Wrap returns the command to run in place of name args: the trampoline when
// wrapping is on and name resolves to an executable, name args untouched
// otherwise. A name that does not resolve is left alone so the caller's own
// start fails as before, with the same error.
func Wrap(name string, args []string) (string, []string) {
	mu.RLock()
	exe := self
	mu.RUnlock()
	if exe == "" {
		return name, args
	}
	path, err := exec.LookPath(name)
	if err != nil {
		return name, args
	}
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	out := make([]string, 0, len(args)+3)
	out = append(out, Arg, path, name)
	out = append(out, args...)
	return exe, out
}

// Main runs the trampoline when the process was started as one, and returns
// at once otherwise. Call it first in main, before anything else starts.
func Main() {
	if len(os.Args) < 4 || os.Args[1] != Arg {
		return
	}
	path, argv := os.Args[2], os.Args[3:]
	err := execDisclaimed(path, argv, os.Environ())
	// Only reached when the program could not be started at all.
	fmt.Fprintf(os.Stderr, "caprock: exec %s: %v\n", path, err)
	os.Exit(127)
}
