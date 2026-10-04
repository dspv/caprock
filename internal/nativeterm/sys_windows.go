//go:build windows

package nativeterm

import "syscall"

// createNewConsole is CREATE_NEW_CONSOLE: the child gets a console window of
// its own instead of sharing the daemon's (which has none).
const createNewConsole = 0x00000010

// detachedProcess is DETACHED_PROCESS, for a GUI terminal (wt.exe) that opens
// its own window and needs no console from the daemon.
const detachedProcess = 0x00000008

func sysProcAttr(newConsole bool) *syscall.SysProcAttr {
	if newConsole {
		return &syscall.SysProcAttr{CreationFlags: createNewConsole}
	}
	return &syscall.SysProcAttr{CreationFlags: detachedProcess}
}
