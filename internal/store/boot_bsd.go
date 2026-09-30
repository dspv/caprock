//go:build darwin || freebsd || netbsd || openbsd

package store

import (
	"time"

	"golang.org/x/sys/unix"
)

func readBootTime() time.Time {
	tv, err := unix.SysctlTimeval("kern.boottime")
	if err != nil {
		return time.Time{}
	}
	return time.Unix(tv.Unix())
}
