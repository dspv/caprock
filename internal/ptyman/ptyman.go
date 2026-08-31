// Package ptyman owns pseudo-terminal sessions: spawn a process attached to a
// PTY (ConPTY on Windows), stream its bytes, write input, resize, signal, kill.
// The interface is ours so the backend is swappable (ADR-006); the first
// backend delegates to github.com/aymanbagabas/go-pty. Nothing in Phase 0
// depends on this package — it exists for the T0 spike and Phase 1 (T11).
package ptyman

import (
	"context"
	"errors"
	"io"
)

// Spec describes a process to spawn.
type Spec struct {
	Command string
	Args    []string
	Dir     string
	Env     []string // nil ⇒ inherit
	Cols    int      // 0 ⇒ 120
	Rows    int      // 0 ⇒ 40
}

// Signal is a control action on an owned session.
type Signal string

const (
	SignalPause  Signal = "pause"  // SIGSTOP on POSIX; input-hold on Windows (no process-level equivalent)
	SignalResume Signal = "resume" // SIGCONT on POSIX; releases the input-hold on Windows
	SignalKill   Signal = "kill"   // terminate the process tree
	// SignalTerm asks the process to stop and lets it clean up first. Claude
	// Code writes its transcript and releases its session on the way out, none
	// of which happens under SIGKILL — so a daemon restart used to take a
	// user's running work with it, silently.
	SignalTerm Signal = "term"
)

// ErrNotSupported is returned for signals the platform cannot honour.
var ErrNotSupported = errors.New("ptyman: signal not supported on this platform")

// Session is a running PTY-attached process.
type Session interface {
	// Output streams the terminal bytes (what xterm.js renders).
	Output() io.Reader
	// Write sends bytes to the process's stdin (typed input).
	Write(p []byte) (int, error)
	// Resize changes the terminal size.
	Resize(cols, rows int) error
	// Signal pauses/resumes/kills the process. Paused sessions on Windows hold input.
	Signal(sig Signal) error
	// Wait blocks until the process exits and returns its exit error (nil = 0).
	Wait() error
	// PID returns the process id (0 before start / after close).
	PID() int
	// Paused reports the pause state (Windows input-hold or POSIX SIGSTOP).
	Paused() bool
	// Close releases the PTY; kills the process if still running.
	Close() error
}

// Manager spawns sessions.
type Manager interface {
	Spawn(ctx context.Context, spec Spec) (Session, error)
}
