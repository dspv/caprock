package ptyman

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"

	gopty "github.com/aymanbagabas/go-pty"
)

// GoPTY is the go-pty backed Manager (creack/pty on POSIX, ConPTY on Windows).
type GoPTY struct{}

// New returns the default manager.
func New() Manager { return GoPTY{} }

type session struct {
	pty    gopty.Pty
	cmd    *gopty.Cmd
	pr     *io.PipeReader
	pw     *io.PipeWriter
	done   chan struct{}
	waitMu sync.Mutex
	err    error
	waited bool
	paused atomic.Bool
	closed atomic.Bool
}

// Spawn starts spec.Command attached to a fresh PTY.
func (GoPTY) Spawn(ctx context.Context, spec Spec) (Session, error) {
	if spec.Command == "" {
		return nil, errors.New("ptyman: empty command")
	}
	cols, rows := spec.Cols, spec.Rows
	if cols <= 0 {
		cols = 120
	}
	if rows <= 0 {
		rows = 40
	}
	p, err := gopty.New()
	if err != nil {
		return nil, err
	}
	if err := p.Resize(cols, rows); err != nil {
		_ = p.Close()
		return nil, err
	}
	// go-pty (like exec) needs a resolvable command; resolve bare names via PATH so
	// callers can pass "claude" / "sh" as well as an absolute path.
	command := spec.Command
	if !filepath.IsAbs(command) {
		if resolved, err := exec.LookPath(command); err == nil {
			command = resolved
		}
	}
	cmd := p.CommandContext(ctx, command, spec.Args...)
	cmd.Dir = spec.Dir
	if spec.Env != nil {
		cmd.Env = spec.Env
	} else {
		cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	}
	if err := cmd.Start(); err != nil {
		_ = p.Close()
		return nil, err
	}
	pr, pw := io.Pipe()
	s := &session{pty: p, cmd: cmd, pr: pr, pw: pw, done: make(chan struct{})}
	// Pump PTY output into the pipe so readers see a plain io.Reader that ends
	// when the process exits and the PTY closes.
	go func() {
		buf := make([]byte, 32<<10)
		for {
			n, err := p.Read(buf)
			if n > 0 {
				if _, werr := pw.Write(buf[:n]); werr != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
		_ = pw.Close()
	}()
	go func() {
		s.waitMu.Lock()
		s.err = cmd.Wait()
		s.waited = true
		s.waitMu.Unlock()
		close(s.done)
		// Give the reader a moment to drain, then close the PTY to end the pump.
		_ = p.Close()
	}()
	return s, nil
}

func (s *session) Output() io.Reader { return s.pr }

func (s *session) Write(b []byte) (int, error) {
	if s.paused.Load() {
		// Input-hold: swallow silently; the caller sees success. Used on Windows
		// where SIGSTOP does not exist (Phase 1 DoD 4).
		return len(b), nil
	}
	return s.pty.Write(b)
}

func (s *session) Resize(cols, rows int) error { return s.pty.Resize(cols, rows) }

func (s *session) Wait() error {
	<-s.done
	s.waitMu.Lock()
	defer s.waitMu.Unlock()
	return s.err
}

func (s *session) PID() int {
	if s.cmd == nil || s.cmd.Process == nil {
		return 0
	}
	return s.cmd.Process.Pid
}

func (s *session) Paused() bool { return s.paused.Load() }

func (s *session) Close() error {
	if s.closed.Swap(true) {
		return nil
	}
	select {
	case <-s.done:
	default:
		_ = s.Signal(SignalKill)
	}
	err := s.pty.Close()
	_ = s.pr.Close()
	// A process that already exited had its PTY closed by the Wait goroutine
	// above, so closing again reports "file already closed". That is the normal
	// ending, not a failure: reporting it would have every caller that checks
	// the error log a problem for a session that finished exactly as intended.
	if errors.Is(err, os.ErrClosed) {
		return nil
	}
	return err
}
