package tcc

import (
	"io/fs"
	"os"
	"path"
	"runtime"
	"strings"
)

// Guarded reports whether reading at or below p would make macOS ask the
// user for access — for any process, isolated or not. Background work (the
// repository a session's folder belongs to, the projects list, the folder
// picker's hints, the Projects panel's git) skips such a place; a read the
// user asked for (opening a session, a file, a folder) does not.
//
// The places are the account's Desktop, Documents and Downloads, iCloud Drive
// and cloud-storage providers, the Music, Movies and Pictures folders (the
// Apple Music, TV and Photos libraries live there), and every mounted volume
// under /Volumes (removable and network volumes each have their own prompt).
// Caprock's binary is ad-hoc signed, so macOS treats each release as a new
// program and an answer given to the last one does not carry over: a
// background read there asked again after every upgrade.
//
// Symbolic links are followed without touching what they point at: a link
// in ~/dev to a network share is guarded, and finding that out reads the
// links, never the share.
func Guarded(p string) bool {
	_, g := resolveGuarded(runtime.GOOS, homes(), p, lstatMode, os.Readlink)
	return g
}

// Target is where p leads once symbolic links are followed, as far as that is
// possible without entering a guarded place, and whether it leads into one.
// A target inside a guarded place is spelled out but never read.
func Target(p string) (string, bool) {
	return resolveGuarded(runtime.GOOS, homes(), p, lstatMode, os.Readlink)
}

// guardedRel are the guarded folders relative to a home directory.
var guardedRel = []string{
	"Desktop", "Documents", "Downloads",
	"Library/Mobile Documents", // iCloud Drive
	"Library/CloudStorage",     // Dropbox, OneDrive, Google Drive (File Provider)
	"Music", "Movies", "Pictures",
}

// homes are the home directories to guard: $HOME and the account's own,
// which differ only for an isolated daemon.
func homes() []string {
	var out []string
	if h := os.Getenv("HOME"); h != "" {
		out = append(out, h)
	}
	if a := accountHome(); a != "" && (len(out) == 0 || a != out[0]) {
		out = append(out, a)
	}
	return out
}

func lstatMode(p string) (fs.FileMode, error) {
	fi, err := os.Lstat(p)
	if err != nil {
		return 0, err
	}
	return fi.Mode(), nil
}

// guardedText is the rule on a path as written: no file system access.
// macOS paths only, so POSIX path rules wherever the test runs.
func guardedText(homes []string, p string) bool {
	within := func(root string) bool {
		return p == root || strings.HasPrefix(p, root+"/")
	}
	if within("/Volumes") {
		return true
	}
	for _, h := range homes {
		if h == "" || !path.IsAbs(h) {
			continue
		}
		h = path.Clean(h)
		for _, r := range guardedRel {
			if within(path.Join(h, r)) {
				return true
			}
		}
	}
	return false
}

// maxHops bounds the links followed for one path, as the kernel's own limit
// does; a loop is not a guarded place.
const maxHops = 40

// resolveGuarded follows the symbolic links in p one component at a time and
// checks each prefix before it is read, so a guarded place is recognised
// before anything inside it is touched. It returns the path reached (the
// fully resolved one when nothing on the way is guarded) and whether it is
// guarded. Off macOS nothing is guarded and nothing is read.
func resolveGuarded(goos string, homes []string, p string, lstat func(string) (fs.FileMode, error), readlink func(string) (string, error)) (string, bool) {
	if goos != "darwin" || p == "" || !path.IsAbs(p) {
		return p, false
	}
	p = path.Clean(p)
	if guardedText(homes, p) {
		return p, true
	}
	parts := strings.Split(strings.TrimPrefix(p, "/"), "/")
	cur, hops := "/", 0
	for i := 0; i < len(parts); i++ {
		if parts[i] == "" {
			continue
		}
		next := path.Join(cur, parts[i])
		if guardedText(homes, next) {
			return path.Join(append([]string{next}, parts[i+1:]...)...), true
		}
		mode, err := lstat(next)
		if err != nil {
			// Gone: nothing further down can be read either.
			return path.Join(append([]string{next}, parts[i+1:]...)...), false
		}
		if mode&fs.ModeSymlink == 0 {
			cur = next
			continue
		}
		if hops++; hops > maxHops {
			return p, false
		}
		target, err := readlink(next)
		if err != nil {
			return p, false
		}
		if !path.IsAbs(target) {
			target = path.Join(cur, target)
		}
		rest := path.Clean(path.Join(append([]string{target}, parts[i+1:]...)...))
		if guardedText(homes, rest) {
			return rest, true
		}
		parts = strings.Split(strings.TrimPrefix(rest, "/"), "/")
		cur, i = "/", -1
	}
	return cur, false
}
