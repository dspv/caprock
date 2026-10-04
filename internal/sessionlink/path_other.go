//go:build !windows

package sessionlink

func samePath(a, b string) bool { return a == b }
