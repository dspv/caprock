//go:build windows

package store

import (
	"errors"

	"golang.org/x/sys/windows"
)

// ProcessAlive reports whether a process is still running.
//
// Windows has no signals, so the unix `Signal(0)` probe answers "error" for
// every pid including live ones — using it here would declare every session
// dead, which is the exact failure this whole change exists to prevent.
//
// OpenProcess with the narrowest right that still proves existence, then
// GetExitCodeProcess: a running process reports STILL_ACTIVE. A handle that
// cannot be opened is treated as gone, except for a permission error, which
// like EPERM on unix is proof the process is there.
//
// The same pid-reuse caveat applies as on unix, and the same reasoning: the
// failure it would cause is a stale row, and the failure of not doing this is
// a session disappearing while somebody works in it.
func ProcessAlive(pid int) bool {
	if pid <= 1 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		// ERROR_ACCESS_DENIED means it exists and is simply not ours to open —
		// the same reasoning as EPERM on unix. errors.Is rather than a
		// comparison because the syscall wrapper wraps it.
		return errors.Is(err, windows.ERROR_ACCESS_DENIED)
	}
	// The handle is only needed for the query below; a failure to close it
	// leaks a handle for the life of the daemon and is worth a line in the log,
	// but it must not change the answer.
	defer func() { _ = windows.CloseHandle(h) }()

	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		// The handle opened, so something is there; a failed query is not
		// evidence of death.
		return true
	}
	const stillActive = 259 // STILL_ACTIVE
	return code == stillActive
}
