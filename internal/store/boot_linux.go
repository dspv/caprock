//go:build linux

package store

import (
	"time"

	"golang.org/x/sys/unix"
)

func readBootTime() time.Time {
	var si unix.Sysinfo_t
	if err := unix.Sysinfo(&si); err != nil {
		return time.Time{}
	}
	return time.Now().Add(-time.Duration(si.Uptime) * time.Second)
}
