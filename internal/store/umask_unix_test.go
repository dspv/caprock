//go:build !windows

package store

import "syscall"

// setUmask sets the process umask and returns the previous value, so a
// permission test proves the chmod rather than inheriting a strict mode from
// whatever shell or CI runner started it. Unix only — Windows has no umask.
func setUmask(mask int) int { return syscall.Umask(mask) }
