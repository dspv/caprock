//go:build windows

package ptyhost

import "syscall"

const (
	createNewProcessGroup  = 0x00000200
	createNoWindow         = 0x08000000
	createBreakawayFromJob = 0x01000000
)

// detachAttempts start the holder in a process group of its own with a hidden
// console of its own, so neither a Ctrl+C to the daemon's group nor the
// daemon's console closing reaches it. ConPTY does not need the caller to have
// a visible console.
//
// The first attempt also leaves the daemon's job object, when there is one: a
// job set to kill on close would otherwise take the holder down with the
// daemon. A job that forbids breakaway refuses the whole CreateProcess, so the
// second attempt goes without that flag rather than failing the session.
func detachAttempts() []*syscall.SysProcAttr {
	return []*syscall.SysProcAttr{
		{CreationFlags: createNewProcessGroup | createNoWindow | createBreakawayFromJob},
		{CreationFlags: createNewProcessGroup | createNoWindow},
	}
}
