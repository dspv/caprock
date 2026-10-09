package tcc

import (
	"errors"
	"io/fs"
	"testing"
)

// fakeFS is a file system of directories and links, so the rule runs on any
// OS without touching the real one — never the owner's ~/Music or /Volumes.
type fakeFS struct {
	links map[string]string
	dirs  map[string]bool
	read  []string // every path lstat or readlink was asked about
}

func (f *fakeFS) lstat(p string) (fs.FileMode, error) {
	f.read = append(f.read, p)
	if _, ok := f.links[p]; ok {
		return fs.ModeSymlink, nil
	}
	if f.dirs[p] {
		return fs.ModeDir, nil
	}
	return 0, fs.ErrNotExist
}

func (f *fakeFS) readlink(p string) (string, error) {
	f.read = append(f.read, p)
	if t, ok := f.links[p]; ok {
		return t, nil
	}
	return "", errors.New("not a link")
}

func newFakeFS() *fakeFS {
	return &fakeFS{
		dirs: map[string]bool{"/Users": true, "/Users/u": true, "/Users/u/dev": true, "/Users/u/dev/caprock": true, "/opt": true, "/opt/code": true},
		links: map[string]string{
			"/Users/u/dev/nas":     "/Volumes/NAS/repo", // a share kept under ~/dev
			"/Users/u/dev/tunes":   "../Music",          // relative, into ~/Music
			"/Users/u/dev/hop":     "nas",               // a link to a link
			"/Users/u/dev/elsewh":  "/opt/code",         // a link that is fine
			"/Users/u/dev/loop":    "loop",
			"/Users/u/dev/docsym":  "/Users/u/Documents/proj",
			"/Users/u/dev/cloud":   "/Users/u/Library/CloudStorage/Dropbox/x",
			"/Users/u/dev/missing": "/nowhere",
		},
	}
}

func TestGuardedPlacesAsWritten(t *testing.T) {
	homes := []string{"/Users/u"}
	for dir, want := range map[string]bool{
		"/Users/u/Documents/Codex/2026-09-06/x20":        true,
		"/Users/u/Downloads/caprock":                     true,
		"/Users/u/Desktop":                               true,
		"/Users/u/Library/Mobile Documents/x/proj":       true,
		"/Users/u/Library/CloudStorage/OneDrive/x":       true,
		"/Users/u/Music":                                 true,
		"/Users/u/Music/Music/Media.localized":           true,
		"/Users/u/Movies/TV":                             true,
		"/Users/u/Pictures/Photos Library.photoslibrary": true,
		"/Volumes/External/repo":                         true,
		"/Volumes":                                       true,
		"/Users/u/dev/caprock":                           false,
		"/Users/u/DocumentsArchive/repo":                 false,
		"/Users/u/MusicTools":                            false,
		"/Users/u/Library/Application Support/x":         false,
		"/VolumesX":                                      false,
	} {
		if got := guardedText(homes, dir); got != want {
			t.Errorf("%q: got %v, want %v", dir, got, want)
		}
	}
}

func TestOnlyMacOSGuardsAndOnlyAbsolutePaths(t *testing.T) {
	f := newFakeFS()
	for _, c := range []struct{ goos, p string }{
		{"linux", "/Users/u/Documents/repo"},
		{"windows", "/Volumes/x"},
		{"darwin", ""},
		{"darwin", "Documents/repo"},
	} {
		if _, g := resolveGuarded(c.goos, []string{"/Users/u"}, c.p, f.lstat, f.readlink); g {
			t.Errorf("%s %q: guarded", c.goos, c.p)
		}
	}
	if len(f.read) != 0 {
		t.Errorf("read the file system for nothing: %v", f.read)
	}
}

func TestLinksAreFollowedWithoutEnteringAGuardedPlace(t *testing.T) {
	for p, want := range map[string]struct {
		target  string
		guarded bool
	}{
		"/Users/u/dev/nas/sub":    {"/Volumes/NAS/repo/sub", true},
		"/Users/u/dev/tunes":      {"/Users/u/Music", true},
		"/Users/u/dev/hop/x":      {"/Volumes/NAS/repo/x", true},
		"/Users/u/dev/docsym":     {"/Users/u/Documents/proj", true},
		"/Users/u/dev/cloud":      {"/Users/u/Library/CloudStorage/Dropbox/x", true},
		"/Users/u/dev/elsewh":     {"/opt/code", false},
		"/Users/u/dev/caprock":    {"/Users/u/dev/caprock", false},
		"/Users/u/Documents/repo": {"/Users/u/Documents/repo", true},
	} {
		f := newFakeFS()
		got, g := resolveGuarded("darwin", []string{"/Users/u"}, p, f.lstat, f.readlink)
		if got != want.target || g != want.guarded {
			t.Errorf("%q: got (%q, %v), want (%q, %v)", p, got, g, want.target, want.guarded)
		}
		for _, r := range f.read {
			if guardedText([]string{"/Users/u"}, r) {
				t.Errorf("%q: read %q, inside a guarded place", p, r)
			}
		}
	}
}

func TestALinkLoopOrADeadLinkIsNotGuarded(t *testing.T) {
	for _, p := range []string{"/Users/u/dev/loop", "/Users/u/dev/missing/x"} {
		f := newFakeFS()
		if _, g := resolveGuarded("darwin", []string{"/Users/u"}, p, f.lstat, f.readlink); g {
			t.Errorf("%q: guarded", p)
		}
	}
}

func TestEveryHomeIsGuarded(t *testing.T) {
	// An isolated daemon's HOME and the account's home both count.
	homes := []string{"/tmp/iso", "/Users/u"}
	for _, p := range []string{"/tmp/iso/Documents/x", "/Users/u/Music/x"} {
		if !guardedText(homes, p) {
			t.Errorf("%q: not guarded", p)
		}
	}
}
