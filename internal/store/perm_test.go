package store

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// modeOf returns a file's permission bits, failing the test if it is missing.
func modeOf(t *testing.T, path string) os.FileMode {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return fi.Mode().Perm()
}

// TestDBFileModeOnCreate: a freshly created database must be 0600, not whatever
// the process umask produced (0644 under the default umask). The file holds
// prompts and responses in cleartext, so a world-readable mode hands every
// other local account the user's whole session history.
func TestDBFileModeOnCreate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX file modes do not exist on Windows; access there is governed by the data directory's inherited ACL, and os.Chmod only toggles the read-only attribute")
	}
	// A permissive umask, so the test proves the chmod rather than inheriting a
	// strict mode from the environment that runs it.
	old := setUmask(0)
	defer setUmask(old)

	dir := t.TempDir()
	path := filepath.Join(dir, "caprock.db")
	st, err := Open(context.Background(), path, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	if got := modeOf(t, path); got != 0o600 {
		t.Fatalf("caprock.db mode = %04o, want 0600", got)
	}
	// The WAL and shared-memory siblings carry the same content and must not be
	// left readable. They exist while a connection is open in WAL mode.
	for _, suffix := range []string{"-wal", "-shm"} {
		p := path + suffix
		if _, err := os.Stat(p); os.IsNotExist(err) {
			continue // not materialised yet on this platform/run
		}
		if got := modeOf(t, p); got != 0o600 {
			t.Errorf("%s mode = %04o, want 0600", filepath.Base(p), got)
		}
	}
}

// TestDBFileModeOnOpeningExisting0644: the bug as it exists on a real machine.
// Every database created before this fix is 0644 and stays that way until
// something changes it, so tightening only at creation would leave every
// current user exposed. Opening must repair it.
func TestDBFileModeOnOpeningExisting0644(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX file modes do not exist on Windows; see TestDBFileModeOnCreate")
	}
	old := setUmask(0)
	defer setUmask(old)

	dir := t.TempDir()
	path := filepath.Join(dir, "caprock.db")

	// Create the database, then put it back the way a pre-fix daemon left it.
	st, err := Open(context.Background(), path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		if _, err := os.Stat(p); err == nil {
			if err := os.Chmod(p, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	if got := modeOf(t, path); got != 0o644 {
		t.Fatalf("precondition: mode = %04o, want 0644", got)
	}

	// Reopening the existing, world-readable database must fix it.
	st2, err := Open(context.Background(), path, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()

	if got := modeOf(t, path); got != 0o600 {
		t.Fatalf("existing 0644 database after open: mode = %04o, want 0600", got)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		p := path + suffix
		if _, err := os.Stat(p); os.IsNotExist(err) {
			continue
		}
		if got := modeOf(t, p); got != 0o600 {
			t.Errorf("%s after open: mode = %04o, want 0600", filepath.Base(p), got)
		}
	}
}

// TestSecureDBFilesIsSafeOnMissingAndMemory: the helper must not error on the
// paths Open legitimately hands it — an in-memory database has no file, and a
// -wal/-shm sibling is absent whenever no connection is open.
func TestSecureDBFilesIsSafeOnMissingAndMemory(t *testing.T) {
	if err := secureDBFiles(":memory:"); err != nil {
		t.Errorf("secureDBFiles(\":memory:\") = %v, want nil", err)
	}
	if err := secureDBFiles(""); err != nil {
		t.Errorf("secureDBFiles(\"\") = %v, want nil", err)
	}
	if err := secureDBFiles(filepath.Join(t.TempDir(), "absent.db")); err != nil {
		t.Errorf("secureDBFiles(missing) = %v, want nil", err)
	}
}
