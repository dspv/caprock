//go:build !windows

package nativeterm

import "syscall"

// sysProcAttr puts a terminal started directly in a session of its own, so it
// is not the daemon's to take down with it.
func sysProcAttr(bool) *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }
