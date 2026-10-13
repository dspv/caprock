//go:build windows

package daemon

import (
	"os"

	"golang.org/x/sys/windows"
)

// terminate ends the process at once: Windows has no SIGTERM to ask with.
// A holder's pseudoconsole closes, which closes the shell attached to it.
func terminate(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}

// kill is terminate: there is nothing harder to send.
func kill(pid int) error { return terminate(pid) }

// exited reports whether pid names a process that has already ended. On
// Windows a terminated process stays queryable — start time and all — while
// anyone holds a handle to it, so the start-time check alone would take it
// for running, and a second TerminateProcess on it answers "Access is
// denied". A process that cannot be opened is not called exited: the
// start-time check decides then.
func exited(pid int32) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer func() { _ = windows.CloseHandle(h) }()
	ev, err := windows.WaitForSingleObject(h, 0)
	return err == nil && ev == windows.WAIT_OBJECT_0
}
