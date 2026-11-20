package readiness

import (
	"os"
	"path/filepath"
	"strings"
)

// GitFinder looks for Git without running it. Running `git --version` on a
// Mac without the Command Line Tools would open Apple's install dialog from a
// daemon on a timer, so the answer is read from the file system only.
type GitFinder struct {
	GOOS string
	// Dirs is the user's PATH as it is now (userenv.CurrentPath), split.
	Dirs []string
	// Env reads a variable (ProgramFiles, LOCALAPPDATA on Windows).
	Env func(string) string
	// IsFile reports whether a path is a regular file. Swapped by tests.
	IsFile func(string) bool
}

// macShim is the stub macOS ships at /usr/bin/git: present on every Mac, it
// only offers to install the Command Line Tools until they are there.
const macShim = "/usr/bin/git"

// macReal are where the Command Line Tools or Xcode put the real Git, which
// the shim runs once they exist.
var macReal = []string{
	"/Library/Developer/CommandLineTools/usr/bin/git",
	"/Applications/Xcode.app/Contents/Developer/usr/bin/git",
}

// Found reports whether Git is installed.
func (f GitFinder) Found() bool {
	isFile := f.IsFile
	if isFile == nil {
		isFile = regularFile
	}
	env := f.Env
	if env == nil {
		env = os.Getenv
	}
	names := []string{"git"}
	dirs := append([]string(nil), f.Dirs...)
	switch f.GOOS {
	case "windows":
		names = []string{"git.exe", "git.cmd"}
		// Git for Windows' own places, for a PATH that does not carry them
		// (the installer's "Git from the command line" option turned off).
		for _, base := range []string{env("ProgramFiles"), env("ProgramW6432"), env("ProgramFiles(x86)")} {
			if base != "" {
				dirs = append(dirs, filepath.Join(base, "Git", "cmd"))
			}
		}
		if la := env("LOCALAPPDATA"); la != "" {
			dirs = append(dirs, filepath.Join(la, "Programs", "Git", "cmd"))
		}
	case "darwin":
		dirs = append(dirs, "/opt/homebrew/bin", "/usr/local/bin")
	default:
		dirs = append(dirs, "/usr/bin", "/usr/local/bin", "/bin")
	}
	for _, d := range dirs {
		if d == "" {
			continue
		}
		for _, n := range names {
			p := filepath.Join(d, n)
			if f.GOOS == "darwin" && strings.TrimRight(filepath.ToSlash(p), "/") == macShim {
				continue // the shim, judged below
			}
			if isFile(p) {
				return true
			}
		}
	}
	if f.GOOS == "darwin" {
		for _, p := range macReal {
			if isFile(p) {
				return true
			}
		}
	}
	return false
}

func regularFile(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular()
}
