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

	"github.com/dspv/caprock/internal/termbuf"
)

// Spec describes a process to spawn.
type Spec struct {
	// ID names the session to a backend that keeps it outside this process
	// (internal/ptyhost files its registry entry under it). The in-process
	// backend ignores it.
	ID string
	// Meta is carried by a backend that keeps the session outside this
	// process and handed back when the session is reattached: what the
	// manager needs to know about a session it did not start in this run
	// (which agent, the port its server listens on). The in-process backend
	// ignores it.
	Meta    map[string]string
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

// ErrDetached is what Wait returns for a session that was let go of rather
// than ended: its process is still running, held by a pty-host, and the next
// daemon picks it back up. It is not an exit and must not be recorded as one.
var ErrDetached = errors.New("ptyman: detached; the process keeps running in its pty-host")

// Detacher is a session whose process lives outside the daemon. Detach drops
// the daemon's connection and leaves the process running, which is what a
// daemon restart or upgrade does to it.
type Detacher interface {
	Detach() error
}

// Ringed is a session that keeps its own scrollback ring, with offsets that
// continue across daemon restarts (a pty-host's). The daemon uses that ring
// rather than starting one at zero.
type Ringed interface {
	Ring() *termbuf.Ring
}

// SeqWriter is a session that applies sequenced input exactly once per client
// itself (terminal protocol v2), so the guarantee outlives the daemon.
// WriteSeq returns the client's last applied sequence; sequence 0 writes
// nothing and only asks for it. ErrNotSupported means the daemon must
// deduplicate on its own.
type SeqWriter interface {
	WriteSeq(client string, seq uint64, p []byte) (uint64, error)
}

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
