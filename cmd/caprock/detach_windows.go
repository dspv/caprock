//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

const (
	createNewProcessGroup = 0x00000200
	createNoWindow        = 0x08000000
)

// setDetached starts the daemon in a process group of its own with a console
// that has no window. Not DETACHED_PROCESS: a daemon with no console at all
// makes every console program it starts (git, gh, claude -p) open a window of
// its own, which flashes and steals the keyboard focus every few seconds
// (user report on Windows 10, 2026-10-15). With a hidden console the children
// share it, and so do theirs (git's ssh and credential helpers).
func setDetached(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNewProcessGroup | createNoWindow}
}
