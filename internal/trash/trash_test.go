package trash

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// systemTrash reports whether this run may put test files into the real
// user's Trash: on macOS and Windows the system call ignores $HOME, so it
// runs only on CI (a throwaway runner) or when asked for.
func systemTrash(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		return
	}
	if os.Getenv("CI") == "" && os.Getenv("CAPROCK_TEST_SYSTEM_TRASH") == "" {
		t.Skip("puts a file into this user's Trash; runs on CI or with CAPROCK_TEST_SYSTEM_TRASH=1")
	}
}

func TestMoveRefusesARelativePathAndAMissingOne(t *testing.T) {
	if err := Move("relative/file"); err == nil {
		t.Fatal("a relative path was accepted")
	}
	if err := Move(filepath.Join(t.TempDir(), "nope")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a missing path: %v", err)
	}
}

func TestMoveTakesAFileAndAFolder(t *testing.T) {
	systemTrash(t)
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Setenv("XDG_DATA_HOME", filepath.Join(t.TempDir(), "data"))
	}
	if ok, why := Supported(); !ok {
		t.Fatalf("no trash here: %s", why)
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "caprock-trash-test.txt")
	folder := filepath.Join(dir, "caprock-trash-folder")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(folder, "inner"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "inner", "a"), []byte("y"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{file, folder} {
		if err := Move(p); err != nil {
			t.Fatalf("move %s: %v", p, err)
		}
		if _, err := os.Lstat(p); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("%s is still there: %v", p, err)
		}
	}
}

// The home trash keeps the item and an info file saying where it was, and
// a second item of the same name gets a name of its own.
func TestHomeTrashLayout(t *testing.T) {
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		t.Skip("the freedesktop.org layout is Linux's and the BSDs'")
	}
	data := filepath.Join(t.TempDir(), "data")
	t.Setenv("XDG_DATA_HOME", data)
	dir := t.TempDir()
	for i := 0; i < 2; i++ {
		p := filepath.Join(dir, "same name.txt")
		if err := os.WriteFile(p, []byte{byte('a' + i)}, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := Move(p); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"same name.txt", "same name.1.txt"} {
		if _, err := os.Stat(filepath.Join(data, "Trash", "files", name)); err != nil {
			t.Fatalf("%s not in the trash: %v", name, err)
		}
		b, err := os.ReadFile(filepath.Join(data, "Trash", "info", name+".trashinfo"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(string(b), "[Trash Info]\nPath=") || !strings.Contains(string(b), "same%20name.txt") || !strings.Contains(string(b), "DeletionDate=") {
			t.Fatalf("info file: %q", b)
		}
	}
}

// A symlink goes to the Trash as itself; what it points at stays.
func TestMoveTakesTheLinkNotItsTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need a privilege on Windows")
	}
	systemTrash(t)
	if runtime.GOOS != "darwin" {
		t.Setenv("XDG_DATA_HOME", filepath.Join(t.TempDir(), "data"))
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "target.txt")
	link := filepath.Join(dir, "caprock-trash-link")
	if err := os.WriteFile(target, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := Move(link); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("the link's target went too: %v", err)
	}
}
