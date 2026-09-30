//go:build !darwin && !freebsd && !netbsd && !openbsd && !linux && !windows

package store

import "time"

func readBootTime() time.Time { return time.Time{} }
