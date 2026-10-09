package store

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Ingest resolves a session's folder to its repository in the background, so
// it must not read inside a folder macOS guards: a session in Documents or on
// a share would otherwise ask for it after every release. The session keeps
// its folder's name; a repository elsewhere is found as before. Only the
// test's own temp home is touched.
func TestARepositoryInAGuardedFolderIsNotWalked(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("only macOS guards folders")
	}
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	guarded := filepath.Join(home, "Documents", "proj")
	open := filepath.Join(home, "dev", "proj")
	for _, d := range []string{filepath.Join(guarded, ".git"), filepath.Join(guarded, "sub"), filepath.Join(open, ".git")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if got := resolveRepo(normalizeCwd(filepath.Join(guarded, "sub"))); got.Root != "" || got.Repo != "sub" {
		t.Errorf("guarded: want no root and the folder's name, got %+v", got)
	}
	if ProjectWorthListing(guarded) {
		t.Error("a guarded repository was probed for the projects list")
	}
	if got := resolveRepo(normalizeCwd(open)); got.Root != normalizeCwd(open) {
		t.Errorf("an ordinary repository was not found: %+v", got)
	}
	// (Whether `open` is worth listing is not asked: it is under the temp
	// directory, which is never listed.)
}
