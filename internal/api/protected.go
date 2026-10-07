package api

import (
	"os"
	"path"
	"runtime"
	"strings"
)

// protectedDir reports whether reading dir would make macOS ask the user for
// access: Desktop, Documents, Downloads, iCloud Drive and removable or network
// volumes are behind a privacy prompt for every process, and an ad-hoc signed
// binary is a new process to macOS on each release. Background reads skip
// such a directory; a read the user asked for (opening the session) does not.
// The owner was asked for Documents and Downloads on opening the dashboard,
// because the Projects panel ran git in old Codex sessions' folders
// (2026-10-07).
func protectedDir(dir string) bool {
	return protectedUnder(runtime.GOOS, userHome(), dir)
}

func userHome() string {
	h, _ := os.UserHomeDir()
	return h
}

func protectedUnder(goos, home, dir string) bool {
	if goos != "darwin" || dir == "" {
		return false
	}
	// macOS paths only, so POSIX path rules wherever the test runs.
	dir = path.Clean(dir)
	within := func(root string) bool {
		return dir == root || strings.HasPrefix(dir, root+"/")
	}
	if within("/Volumes") {
		return true
	}
	if home == "" {
		return false
	}
	for _, p := range []string{"Desktop", "Documents", "Downloads", "Library/Mobile Documents"} {
		if within(path.Join(home, p)) {
			return true
		}
	}
	return false
}
