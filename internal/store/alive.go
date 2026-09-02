//go:build !windows

package store

import (
	"errors"
	"os"
	"syscall"
)

// ProcessAlive reports whether a process is still running.
//
// This is what replaced a timer. Caprock used to decide a session was over
// because it had been quiet for a while, and every number chosen for "a while"
// was wrong for somebody: twelve hours left the day's sessions live at
// midnight, and one hour closed a session while its owner was at lunch. A
// session is over when its process is gone, which is a fact rather than a
// guess, and the only reason the staleness sweep still exists at all is
// sessions whose pid was never learned.
//
// On unix, signal 0 is the "does this pid exist and may I signal it" test: it
// performs the permission and existence checks and delivers nothing. A pid
// belonging to another user answers EPERM, which is still proof the process is
// there — Caprock is single-user, but a session left by `sudo` should not be
// declared dead because of a permission error.
//
// The known unsoundness is pid reuse: a dead process's number can be handed to
// a new one, and this would call that session alive. Detecting it means
// comparing process start times, which is three platforms of code for a case
// that requires a wrap of the pid space between two sweeps. The failure it
// would prevent is a stale row in a list; the failure of not doing this at all
// was a session vanishing while somebody worked in it.
func ProcessAlive(pid int) bool {
	if pid <= 1 {
		// 0 is "unknown" and 1 is init, which is never a Claude Code session
		// and is always alive — treating it as one would make an unknown pid
		// immortal.
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = p.Signal(syscall.Signal(0))
	if err == nil {
		return true
	}
	// EPERM means the process exists and is simply not ours to signal, which is
	// still proof it is there. errors.Is rather than a comparison because
	// os.Process.Signal wraps the errno.
	return errors.Is(err, os.ErrPermission) || errors.Is(err, syscall.EPERM)
}
