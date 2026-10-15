//go:build windows

package hidewin

import (
	"os/exec"
	"syscall"
)

const (
	createNoWindow  = 0x08000000
	detachedProcess = 0x00000008
)

// Hide gives cmd a console with no window, keeping whatever it already set
// (a command line, a process group). DETACHED_PROCESS is dropped: Windows
// ignores CREATE_NO_WINDOW beside it, and a console program started detached
// opens a window of its own for its own children.
func Hide(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags = cmd.SysProcAttr.CreationFlags&^detachedProcess | createNoWindow
}
