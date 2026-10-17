//go:build !darwin && !windows

package browser

import (
	"os"
	"runtime"
	"strings"
)

// DetectHere lists the browsers installed: on Linux the desktop entries that
// handle web links (desktop.go), read from the real root and the user's XDG
// dirs; elsewhere none.
func DetectHere(env []string) []Browser {
	if runtime.GOOS != "linux" {
		return nil
	}
	return DetectDesktop(os.DirFS("/"), XDGFrom(env), func(name string) string {
		if strings.HasPrefix(name, "/") {
			if st, err := os.Stat(name); err == nil && !st.IsDir() {
				return name
			}
			return ""
		}
		return lookPath(env, name)
	})
}
