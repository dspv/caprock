//go:build windows

package store

import (
	"time"

	"golang.org/x/sys/windows"
)

func readBootTime() time.Time {
	return time.Now().Add(-windows.DurationSinceBoot())
}
