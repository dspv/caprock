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
	case SignalKill:
		if s.cmd == nil || s.cmd.Process == nil {
			return nil
		}
		return s.cmd.Process.Kill()
	}
	return ErrNotSupported
}
