package api

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Listing home must not read inside a folder macOS guards, nor follow a link
// into one: the owner was asked for the Music library and a network volume.
// Guarded folders are still offered by name (descending is the user's own
// request), never probed for a repository; a link out of the root to a share
// is not offered at all. Only the test's own temp home is touched.
func TestBrowseOffersGuardedFoldersWithoutReadingThem(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("only macOS guards folders")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", root)
	for _, d := range []string{"Music/.git", "Documents", "dev/.git"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for name, target := range map[string]string{
		"nas":   "/Volumes/CaprockTestNoSuchShare/repo",
		"tunes": filepath.Join(root, "Music"),
	} {
		if err := os.Symlink(target, filepath.Join(root, name)); err != nil {
			t.Fatal(err)
		}
	}

	e := newEnv(t)
	e.setBrowseRoot(t, root)
	var got browseResponse
	if code := e.get(t, "/v1/browse", &got); code != 200 {
		t.Fatalf("GET /v1/browse: %d", code)
	}
	names := map[string]browseEntry{}
	for _, en := range got.Entries {
		names[en.Name] = en
	}
	for _, n := range []string{"Music", "Documents", "tunes"} {
		if en, ok := names[n]; !ok || en.Repo {
			t.Errorf("%s: want listed and not probed, got %+v (listed %v)", n, en, ok)
		}
	}
	if _, ok := names["nas"]; ok {
		t.Error("a link to a share outside the root was offered")
	}
	if en, ok := names["dev"]; !ok || !en.Repo {
		t.Errorf("an ordinary repository lost its mark: %+v", en)
	}
}
