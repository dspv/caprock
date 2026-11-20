package userenv

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestMergePathsKeepsFreshFirstAndDropsDuplicates(t *testing.T) {
	got := mergePaths(`C:\Windows\system32;C:\Program Files\Git\cmd`, `c:\windows\System32\;C:\caprock`, ";", true)
	if got != `C:\Windows\system32;C:\Program Files\Git\cmd;C:\caprock` {
		t.Fatalf("windows: %q", got)
	}
	if got := mergePaths("/opt/homebrew/bin:/usr/bin", "/usr/bin:/Usr/bin", ":", false); got != "/opt/homebrew/bin:/usr/bin:/Usr/bin" {
		t.Fatalf("posix: %q", got)
	}
}

func TestWithPathKeepsTheVariablesSpelling(t *testing.T) {
	got := withPath([]string{"Path=old", "HOME=x"}, "new")
	if strings.Join(got, "|") != "HOME=x|Path=new" {
		t.Fatalf("%q", got)
	}
}

// swapRegistry makes the registry say path (or fail) for one test.
func swapRegistry(t *testing.T, path string, err error) {
	t.Helper()
	old := registryPath
	registryPath = func() (string, error) { return path, err }
	regMu.Lock()
	regAt = time.Time{}
	regMu.Unlock()
	t.Cleanup(func() {
		registryPath = old
		regMu.Lock()
		regAt = time.Time{}
		regMu.Unlock()
	})
}

// The daemon's own PATH keeps its order: the registry only adds what it
// lacks. Registry first put a runner's older Go ahead of setup-go's, which
// broke the smoke test on Windows CI (2026-11-20).
func TestCurrentPathOnWindowsKeepsTheDaemonsOrder(t *testing.T) {
	t.Setenv("PATH", `C:\hostedtoolcache\go\1.26\bin;C:\Windows\system32`)
	swapRegistry(t, `C:\Program Files\Go\bin;C:\Windows\system32;C:\Program Files\Git\cmd`, nil)
	p, _ := currentPath(nil, "windows")
	if p != `C:\hostedtoolcache\go\1.26\bin;C:\Windows\system32;C:\Program Files\Go\bin;C:\Program Files\Git\cmd` {
		t.Fatalf("%q", p)
	}
}

// Windows: Git installed after the daemon started is on the registry's PATH,
// not the process's; the check reads the registry again, on every OS's CI.
func TestCurrentPathOnWindowsReadsTheRegistryAgain(t *testing.T) {
	t.Setenv("PATH", `C:\caprock`)
	swapRegistry(t, `C:\Windows\system32`, nil)
	p, fresh := currentPath(nil, "windows")
	if !fresh || p != `C:\caprock;C:\Windows\system32` {
		t.Fatalf("first: %q %v", p, fresh)
	}
	// The installer adds Git for Windows to the system Path.
	swapRegistry(t, `C:\Windows\system32;C:\Program Files\Git\cmd`, nil)
	if p, _ = currentPath(nil, "windows"); !strings.Contains(p, `C:\Program Files\Git\cmd`) {
		t.Fatalf("after the install: %q", p)
	}
	// Unreadable: the daemon's own, and not fresh — the checklist says restart.
	swapRegistry(t, "", errors.New("access denied"))
	if p, fresh = currentPath(nil, "windows"); fresh || p != `C:\caprock` {
		t.Fatalf("unreadable: %q %v", p, fresh)
	}
}

// macOS and Linux: the login shell's PATH, re-read in the background once
// stale, so a Homebrew or package install shows within a TTL.
func TestCurrentPathOnPosixFollowsTheLoginShell(t *testing.T) {
	reset()
	t.Cleanup(reset)
	t.Setenv("PATH", "/usr/bin")
	shellPath := "/usr/bin:/bin"
	resolveFn = func(context.Context, string, []string) ([]string, error) { return []string{"PATH=" + shellPath}, nil }
	t.Cleanup(func() { resolveFn = resolve })
	clock := time.Unix(1_700_000_000, 0)
	now = func() time.Time { return clock }
	t.Cleanup(func() { now = time.Now })

	// Never resolved: the daemon's own, not fresh, and a resolution starts.
	if p, fresh := currentPath(nil, "linux"); fresh || p != "/usr/bin" {
		t.Fatalf("before: %q %v", p, fresh)
	}
	waitFor(t, func() bool { p, f := currentPath(nil, "linux"); return f && p == "/usr/bin:/bin" })

	// The user installs something that lands on their profile's PATH.
	shellPath = "/home/u/.local/bin:/usr/bin:/bin"
	clock = clock.Add(TTL + time.Second)
	waitFor(t, func() bool { p, _ := currentPath(nil, "linux"); return strings.HasPrefix(p, "/home/u/.local/bin:") })
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out")
}

// The real registry, read only, on Windows itself.
func TestRegistryPathOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows only")
	}
	p, err := readRegistryPath()
	if err != nil || !strings.Contains(strings.ToLower(p), `\windows`) {
		t.Fatalf("registry Path: %q %v", p, err)
	}
	if strings.Contains(p, "%") {
		t.Fatalf("not expanded: %q", p)
	}
}
