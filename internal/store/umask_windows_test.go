//go:build windows

package store

// setUmask is a no-op on Windows, which has no umask: the permission tests that
// would call it skip there, and this exists only so the package compiles on the
// Windows CI job (rule 2).
func setUmask(int) int { return 0 }
