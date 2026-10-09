//go:build darwin || linux

package fgproc

// firstArg is argv[0] from a NUL-separated argument block.
func firstArg(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}
