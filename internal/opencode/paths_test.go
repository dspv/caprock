package opencode

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Where another program keeps its database is a guess until it is checked, and
// a guess that only one of three platforms ever exercises is a guess nobody
// checks. These run the search order for every platform regardless of the one
// the test is on — the Windows expectations fail on a Mac if the logic is
// wrong, which is the whole point.

// env builds a getenv stand-in from a map, so a test can describe an
// environment rather than mutate the process's.
func env(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

// contains reports whether the search order includes a path.
//
// Both sides are normalised to forward slashes AND backslashes collapsed,
// because filepath.Join uses the separator of the machine running the test:
// a Windows path built on a Mac comes back as `C:\Users\dev\AppData/opencode`,
// mixing both. On real Windows it is uniform. The test is about which
// directories are searched, not about how the separator renders.
func norm(p string) string {
	return strings.ReplaceAll(filepath.ToSlash(p), `\`, "/")
}

func contains(dirs []string, want string) bool {
	for _, d := range dirs {
		if norm(d) == norm(want) {
			return true
		}
	}
	return false
}

func TestDataDirsMac(t *testing.T) {
	dirs := dataDirsFor("darwin", env(nil), "/Users/dev")

	// Verified against a real installation: OpenCode writes to the XDG path on
	// macOS, following the Linux convention rather than the platform one. This
	// is the case that would be silently wrong if the code assumed
	// Application Support, which is what a macOS-shaped guess would do.
	want := "/Users/dev/.local/share/opencode"
	if !contains(dirs, want) {
		t.Errorf("macOS search order %v is missing %s", dirs, want)
	}
	if norm(dirs[0]) != norm(want) {
		t.Errorf("macOS looks in %s before the observed location", dirs[0])
	}
	// Application Support is not where OpenCode writes — `opencode db path`
	// prints the XDG location — but it is the platform-native place a future
	// version would most plausibly move to, and one stat is cheap insurance.
	if !contains(dirs, "/Users/dev/Library/Application Support/opencode") {
		t.Errorf("macOS search order %v does not fall back to Application Support", dirs)
	}
}

func TestDataDirsLinux(t *testing.T) {
	dirs := dataDirsFor("linux", env(nil), "/home/dev")
	want := "/home/dev/.local/share/opencode"
	if !contains(dirs, want) {
		t.Errorf("Linux search order %v is missing %s", dirs, want)
	}
	// A Mac-only path on Linux would be a wasted stat and a sign the platform
	// switch is not doing its job.
	for _, d := range dirs {
		if strings.Contains(d, "Library/Application Support") {
			t.Errorf("Linux looks in a macOS location: %s", d)
		}
	}
}

func TestDataDirsWindows(t *testing.T) {
	// The correction that testing every platform exists for. OpenCode uses
	// `xdg-basedir`, which has no platform branching at all: on Windows it is
	// `%USERPROFILE%\.local\share`, and neither LOCALAPPDATA nor APPDATA is
	// consulted. Searching those was a reasonable guess and a wrong one —
	// Caprock would have found nothing on every Windows machine.
	dirs := dataDirsFor("windows", env(map[string]string{
		"LOCALAPPDATA": `C:\Users\dev\AppData\Local`,
		"APPDATA":      `C:\Users\dev\AppData\Roaming`,
	}), `C:\Users\dev`)

	want := `C:/Users/dev/.local/share/opencode`
	if !contains(dirs, want) {
		t.Errorf("Windows search order %v is missing %s", dirs, want)
	}
	for _, d := range dirs {
		if strings.Contains(norm(d), "AppData") {
			t.Errorf("Windows looks in %s, which OpenCode never writes to", d)
		}
	}
}

func TestXDGWinsEverywhere(t *testing.T) {
	// A user who sets XDG_DATA_HOME has said where their data lives, and
	// OpenCode honours it on every platform. Checking a default location
	// first would find a stale database on a machine that moved.
	for _, goos := range []string{"darwin", "linux", "windows"} {
		dirs := dataDirsFor(goos, env(map[string]string{
			"XDG_DATA_HOME": "/data/xdg",
			"LOCALAPPDATA":  `C:\Users\dev\AppData\Local`,
		}), "/home/dev")
		if len(dirs) == 0 {
			t.Fatalf("%s: no candidates", goos)
		}
		if norm(dirs[0]) != "/data/xdg/opencode" {
			t.Errorf("%s looks in %s before XDG_DATA_HOME", goos, dirs[0])
		}
	}
}

func TestDataDirsWithoutAHome(t *testing.T) {
	// os.UserHomeDir can fail — a service account, a stripped environment. It
	// must yield no candidates rather than paths rooted at "".
	for _, goos := range []string{"darwin", "linux", "windows"} {
		for _, d := range dataDirsFor(goos, env(nil), "") {
			if strings.HasPrefix(norm(d), "/.local") ||
				strings.HasPrefix(norm(d), "/Library") {
				t.Errorf("%s built a rootless path with no home: %s", goos, d)
			}
		}
	}
}

func TestWindowsWithoutTheUsualVariables(t *testing.T) {
	// A stripped environment on Windows must not produce paths built from an
	// empty variable, which would be a relative path resolved against the
	// daemon's working directory.
	dirs := dataDirsFor("windows", env(nil), `C:\Users\dev`)
	for _, d := range dirs {
		if !filepath.IsAbs(d) && !strings.HasPrefix(d, `C:`) {
			t.Errorf("relative path from an empty variable: %s", d)
		}
	}
}

func TestFindsChannelSuffixedDatabase(t *testing.T) {
	// Released builds write `opencode.db`, but any other build appends its
	// channel: a locally-built binary writes `opencode-local.db`, a preview
	// build writes its git branch. Someone running a dev build would have had
	// an empty dashboard and no way to tell why.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "opencode-local.db"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := dbInDir(dir); got == "" {
		t.Error("a channel-suffixed database was not found")
	}
}

func TestPlainDatabaseWinsOverAChannel(t *testing.T) {
	// A machine with both a released and a dev build has both files. The
	// released one is the one nearly everybody means.
	dir := t.TempDir()
	for _, n := range []string{"opencode.db", "opencode-local.db"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if got := dbInDir(dir); filepath.Base(got) != "opencode.db" {
		t.Errorf("picked %s over the plain database", filepath.Base(got))
	}
}

func TestNewestChannelWins(t *testing.T) {
	// Several channels and no plain file: the one being written to is the one
	// worth reading, and picking arbitrarily would show a stale history with
	// nothing on screen to say so.
	dir := t.TempDir()
	old := filepath.Join(dir, "opencode-beta-old.db")
	recent := filepath.Join(dir, "opencode-feat-x.db")
	for _, n := range []string{old, recent} {
		if err := os.WriteFile(n, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	if got := dbInDir(dir); got != recent {
		t.Errorf("picked %s, want the most recently written", filepath.Base(got))
	}
}

func TestEmptyDirectoryFindsNothing(t *testing.T) {
	if got := dbInDir(t.TempDir()); got != "" {
		t.Errorf("found %q in an empty directory", got)
	}
}

func TestRelativeOpencodeDBResolvesInsideTheDataDir(t *testing.T) {
	// OpenCode resolves a bare OPENCODE_DB value inside its own data
	// directory. Resolving it against the working directory instead would
	// look for the file beside wherever the daemon started — which for a
	// service is not anywhere the user was thinking of.
	data := t.TempDir()
	if err := os.MkdirAll(filepath.Join(data, "opencode"), 0o755); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(data, "opencode", "custom.db")
	if err := os.WriteFile(want, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_DATA_HOME", data)
	t.Setenv("OPENCODE_DB", "custom.db")

	if got := DBPath(); got != want {
		t.Errorf("DBPath() = %q, want %q", got, want)
	}
}
