//go:build !windows

package ptyhost

import "syscall"

// detachAttempts start the holder in a session of its own. That takes it out
// of the daemon's process group, which is what a service manager signals when
// it stops the daemon: launchd kills the job's process group (the plist also
// sets AbandonProcessGroup, for the same reason), and a terminal's hangup goes
// to its foreground group. systemd is the exception that ignores sessions and
// kills the whole cgroup, which is why the unit sets KillMode=process.
func detachAttempts() []*syscall.SysProcAttr {
	return []*syscall.SysProcAttr{{Setsid: true}}
}
