package daemon

import (
	"os"
	"path/filepath"
	"strings"
)

// stableExecutable is this binary's path as a user should write it into an
// agent's MCP config (ADR-078): the running executable, except that a
// Homebrew keg path (`<prefix>/Cellar/caprock/<version>/bin/caprock`), which
// the next upgrade deletes, is given as the `<prefix>/bin/caprock` link that
// survives it. "" when the path cannot be read.
func stableExecutable() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return stablePath(exe)
}

func stablePath(exe string) string {
	slash := filepath.ToSlash(exe)
	if i := strings.Index(slash, "/Cellar/caprock/"); i > 0 {
		// <version>/bin/<name>
		parts := strings.Split(slash[i+len("/Cellar/caprock/"):], "/")
		if len(parts) == 3 && parts[1] == "bin" {
			return filepath.FromSlash(slash[:i] + "/bin/" + parts[2])
		}
	}
	return exe
}
