//go:build windows

package ptyman

// Windows has no SIGSTOP. Pause = input-hold (Write swallows bytes) + the UI
// shows a warning that the process itself keeps running (Phase 1 DoD 4).
func (s *session) Signal(sig Signal) error {
	switch sig {
	case SignalPause:
		s.paused.Store(true)
		return nil
	case SignalResume:
		s.paused.Store(false)
		return nil
	case SignalTerm:
		// Windows has no SIGTERM for a console process that is not ours to
		// signal; Kill is the only termination primitive. The caller still
		// waits first, so a process that exits on its own is never killed —
		// the graceful path is the wait, not the signal.
		if s.cmd == nil || s.cmd.Process == nil {
			return nil
		}
		return s.cmd.Process.Kill()
	case SignalKill:
		if s.cmd == nil || s.cmd.Process == nil {
			return nil
		}
		return s.cmd.Process.Kill()
	}
	return ErrNotSupported
}
