package userenv

import (
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// The PATH a program the user installs after Caprock started is found on.
//
// A daemon's own PATH is a snapshot taken when it started. Git for Windows,
// Claude Code or Codex installed from the setup checklist afterwards puts its
// directory into the user's PATH — on Windows in the registry, on macOS and
// Linux in the login shell's profile — and the daemon's copy never hears of
// it. "Install Git" followed by "Git: missing" until Caprock is restarted is
// the dead end the checklist exists to remove (the owner's two-computer test,
// 2026-11-20). So the questions "is it installed?" and "what PATH does a
// session get?" read the user's PATH as it is now:
//
//   - Windows: the system and the user `Path` values from the registry
//     (HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment and
//     HKCU\Environment), expanded, added after the daemon's own PATH: what
//     the daemon was started with keeps its order and wins, and only a
//     directory it lacks is appended. Registry first put the machine's
//     older Go ahead of the one CI's setup-go had prepended (2026-11-20),
//     and would do the same to anything a launcher prepends on a user's PC.
//   - macOS and Linux: the login shell's environment (Cached), refreshed in
//     the background once it is older than TTL.

// registryPath reads the system and the user Path from the registry, already
// expanded. Swapped by tests; "" and an error off Windows.
var registryPath = readRegistryPath

// The registry's answer is kept for a moment: Cached is asked on every status
// poll, and the registry changes only when someone installs something.
var (
	regMu   sync.Mutex
	regPath string
	regErr  error
	regAt   time.Time
)

const regTTL = 2 * time.Second

func registryPathCached() (string, error) {
	regMu.Lock()
	defer regMu.Unlock()
	if !regAt.IsZero() && now().Sub(regAt) < regTTL {
		return regPath, regErr
	}
	regPath, regErr = registryPath()
	regAt = now()
	return regPath, regErr
}

// mergePaths is first followed by every entry of then that first lacks.
// Duplicates are dropped — compared case-insensitively when fold (Windows),
// trailing separators ignored — so first keeps its order and nothing of
// either is lost.
func mergePaths(first, then, sep string, fold bool) string {
	seen := map[string]bool{}
	var out []string
	add := func(list string) {
		for _, d := range strings.Split(list, sep) {
			d = strings.TrimSpace(d)
			if d == "" {
				continue
			}
			k := strings.TrimRight(d, `/\`)
			if fold {
				k = strings.ToLower(k)
			}
			if seen[k] {
				continue
			}
			seen[k] = true
			out = append(out, d)
		}
	}
	add(first)
	add(then)
	return strings.Join(out, sep)
}

// withPath replaces PATH in env (whatever its case: Windows spells it Path)
// with path, or adds it.
func withPath(env []string, path string) []string {
	out := make([]string, 0, len(env)+1)
	key := "PATH"
	for _, kv := range env {
		k, _, ok := strings.Cut(kv, "=")
		if ok && strings.EqualFold(k, "PATH") {
			key = k
			continue
		}
		out = append(out, kv)
	}
	return append(out, key+"="+path)
}

// freshEnviron is env with its own PATH followed by the registry's entries it
// lacks (Windows). When the registry cannot be
// read it is env unchanged.
func freshEnviron(env []string) []string {
	fresh, err := registryPathCached()
	if err != nil || fresh == "" {
		return env
	}
	return withPath(env, mergePaths(pathOf(env), fresh, ";", true))
}

// CurrentPath is the user's PATH as a program started now would get it, and
// whether it was read fresh. false means it is the daemon's own snapshot (the
// registry could not be read, or the login shell has not been resolved), so
// something installed after Caprock started may not be seen until Caprock
// restarts — the caller says so.
//
// It never waits: on macOS and Linux a stale login environment is returned at
// once and refreshed in the background, so a checklist polled every few
// seconds sees a new install within about TTL.
func CurrentPath(log *slog.Logger) (string, bool) {
	return currentPath(log, runtime.GOOS)
}

func currentPath(log *slog.Logger, goos string) (string, bool) {
	own := os.Getenv("PATH")
	if goos == "windows" {
		fresh, err := registryPathCached()
		if err != nil || fresh == "" {
			return own, false
		}
		return mergePaths(own, fresh, ";", true), true
	}
	mu.Lock()
	defer mu.Unlock()
	if cached == nil {
		startLocked(log)
		return own, false
	}
	if now().Sub(cachedAt) >= TTL {
		startLocked(log)
	}
	p := pathOf(cached)
	if p == "" {
		return own, false
	}
	// The daemon's own directories stay too: a binary only it can see is
	// still found.
	return mergePaths(p, own, ":", false), true
}

// pathOf is PATH's value in env, the last one winning, whatever its case.
func pathOf(env []string) string {
	for i := len(env) - 1; i >= 0; i-- {
		k, v, ok := strings.Cut(env[i], "=")
		if ok && strings.EqualFold(k, "PATH") {
			return v
		}
	}
	return ""
}

// Dirs splits a PATH into its absolute directories.
func Dirs(path string) []string {
	var out []string
	for _, d := range filepath.SplitList(path) {
		if d != "" && filepath.IsAbs(d) {
			out = append(out, d)
		}
	}
	return out
}
