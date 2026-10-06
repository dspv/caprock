// Package tcc keeps an isolated Caprock daemon out of the folders macOS
// guards with a privacy prompt (ADR-040).
//
// macOS asks before a process reads the account's Desktop, Documents or
// Downloads, and remembers the answer per program — for a command-line
// binary, per path and code signature. A daemon a test, a benchmark or a
// preview starts runs from a build of its own, so every one that reaches
// into those folders is another "caprock" in System Settings → Privacy &
// Security → Files and Folders, and a prompt on the owner's screen. A
// preview that copies the real database knows the real projects, some of
// which live there.
//
// An isolated daemon is one whose HOME is not the account's home: every
// test and stand sets a temporary HOME. Such a daemon refuses those folders
// of the real account, whatever its database says. The daemon the user runs
// has its real HOME and is never limited.
package tcc

import (
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// ErrOffLimits is returned for a path an isolated daemon does not touch.
var ErrOffLimits = errors.New("an isolated daemon does not touch the account's Desktop, Documents or Downloads")

// Folders are the account folders macOS asks about, relative to its home.
var Folders = []string{"Desktop", "Documents", "Downloads"}

var (
	once    sync.Once
	guarded []string
)

// load resolves the guarded folders once: none unless this is macOS and HOME
// is not the account's own home.
func load() {
	once.Do(func() {
		guarded = guardedFor(runtime.GOOS, os.Getenv("HOME"), accountHome())
	})
}

func accountHome() string {
	u, err := user.Current()
	if err != nil {
		return ""
	}
	return u.HomeDir
}

// guardedFor is load's rule, separated so tests run it on any OS.
func guardedFor(goos, home, account string) []string {
	if goos != "darwin" || account == "" || home == "" || same(home, account) {
		return nil
	}
	out := make([]string, 0, len(Folders))
	for _, f := range Folders {
		out = append(out, filepath.Join(resolve(account), f))
	}
	return out
}

func resolve(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return filepath.Clean(p)
}

func same(a, b string) bool { return resolve(a) == resolve(b) }

// Isolated reports whether this daemon runs isolated on macOS and so keeps
// out of the account's guarded folders.
func Isolated() bool {
	load()
	return len(guarded) > 0
}

// OffLimits reports whether an isolated daemon must leave path alone.
func OffLimits(path string) bool {
	load()
	return offLimits(guarded, path)
}

func offLimits(guarded []string, path string) bool {
	if len(guarded) == 0 || path == "" {
		return false
	}
	p := filepath.Clean(path)
	if !filepath.IsAbs(p) {
		return false
	}
	for _, g := range guarded {
		for _, c := range []string{p, resolve(p)} {
			if c == g || strings.HasPrefix(c, g+string(filepath.Separator)) {
				return true
			}
		}
	}
	return false
}

// Check returns ErrOffLimits for a path an isolated daemon must leave alone.
func Check(path string) error {
	if OffLimits(path) {
		return ErrOffLimits
	}
	return nil
}
