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
	case SignalKill:
		// Kill the whole process group when we own it; fall back to the process.
		if pgid, err := syscall.Getpgid(s.cmd.Process.Pid); err == nil && pgid == s.cmd.Process.Pid {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
		return s.cmd.Process.Kill()
	}
	return ErrNotSupported
}
