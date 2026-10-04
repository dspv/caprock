//go:build !windows

package ptyman

import "syscall"

func (s *session) Signal(sig Signal) error {
	if s.cmd == nil || s.cmd.Process == nil {
		return nil
	}
	switch sig {
	case SignalPause:
		if err := s.cmd.Process.Signal(syscall.SIGSTOP); err != nil {
			return err
		}
		s.paused.Store(true)
		return nil
	case SignalResume:
		if err := s.cmd.Process.Signal(syscall.SIGCONT); err != nil {
			return err
		}
		s.paused.Store(false)
		return nil
	case SignalTerm:
		// Same group-first rule as kill: Claude Code spawns children, and
		// signalling only the leader leaves them behind.
		if pgid, err := syscall.Getpgid(s.cmd.Process.Pid); err == nil && pgid == s.cmd.Process.Pid {
			_ = syscall.Kill(-pgid, syscall.SIGTERM)
			return nil
		}
		return s.cmd.Process.Signal(syscall.SIGTERM)
	case SignalKill:
		// Kill the whole process group when we own it; fall back to the process.
		if pgid, err := syscall.Getpgid(s.cmd.Process.Pid); err == nil && pgid == s.cmd.Process.Pid {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
		return s.cmd.Process.Kill()
	}
	return ErrNotSupported
}

// TerminatePID asks a process Caprock started, by pid, to stop: SIGTERM to
// its process group when it leads one (go-pty starts every child in its own
// session, so Claude Code's own children go with it), else to the process.
//
// For a process the daemon no longer holds a handle to — one an older daemon
// started and lost the terminal of. Callers must have established that the
// pid is a session Caprock owns (rule 7); this function cannot tell.
func TerminatePID(pid int) error {
	if pid <= 1 {
		return nil
	}
	if pgid, err := syscall.Getpgid(pid); err == nil && pgid == pid {
		return syscall.Kill(-pgid, syscall.SIGTERM)
	}
	return syscall.Kill(pid, syscall.SIGTERM)
}

// KillPID is TerminatePID's last resort: SIGKILL, group first.
func KillPID(pid int) error {
	if pid <= 1 {
		return nil
	}
	if pgid, err := syscall.Getpgid(pid); err == nil && pgid == pid {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	}
	return syscall.Kill(pid, syscall.SIGKILL)
}
