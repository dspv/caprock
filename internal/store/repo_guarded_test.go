package store

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Ingest resolves a session's folder to its repository in the background. A
// session in Documents is grouped by its repository as anywhere else — the
// first user keeps every project there — but a folder in a media library or
// on a share is not walked: that would ask for the Music library or a network
// volume after every release, for a label. Only the test's own temp home is
// touched.
func TestARepositoryIsWalkedInDocumentsButNotInMusic(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("only macOS guards folders")
	}
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	docs := filepath.Join(home, "Documents", "rateguard")
	music := filepath.Join(home, "Music", "proj")
	for _, d := range []string{
		filepath.Join(docs, ".git"), filepath.Join(docs, "sub"),
		filepath.Join(music, ".git"), filepath.Join(music, "sub"),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if got := resolveRepo(normalizeCwd(filepath.Join(docs, "sub"))); got.Root != normalizeCwd(docs) {
		t.Errorf("Documents: want the repository %q, got %+v", docs, got)
	}
	if got := resolveRepo(normalizeCwd(filepath.Join(music, "sub"))); got.Root != "" || got.Repo != "sub" {
		t.Errorf("Music: want no root and the folder's name, got %+v", got)
	}
	if ProjectWorthListing(music) {
		t.Error("a repository in Music was probed for the projects list")
	}
	// (Whether `docs` is worth listing is not asked: it is under the temp
	// directory, which is never listed.)
}
