package store

import (
	"sync"
	"time"
)

// BootTime is when the machine last started, or the zero time when the
// platform cannot say.
//
// It closes the one hole in ProcessAlive that is not rare: a reboot. The pid
// space starts again from the bottom, so the small numbers Claude Code
// sessions held yesterday are handed straight back out to whatever starts
// first, and a session from before the reboot was called alive for as long as
// that stranger ran. No process from before a boot can be running after it,
// so a session last heard from before the boot is over whatever its pid says.
func BootTime() time.Time {
	bootOnce.Do(func() { bootAt = readBootTime() })
	return bootAt
}

// bootTime is BootTime behind a variable, so a test can reboot the machine.
var bootTime = BootTime

var (
	bootOnce sync.Once
	bootAt   time.Time
)
