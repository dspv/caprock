// WriteFileAtomic is what keeps runtime.json, task files and mailboxes readable
// while another process is looking at them. A half-written runtime.json is the
// worst case in the product: the shim reads it on every hook, so a torn file
// silently stops every session from being recorded.
package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestWriteFileAtomicCreatesAndOverwrites(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.json")

	if err := WriteFileAtomic(path, []byte("first"), 0o600); err != nil {
		t.Fatalf("create: %v", err)
	}
	if b, err := os.ReadFile(path); err != nil || string(b) != "first" {
		t.Fatalf("read = %q, %v", b, err)
	}
	// Overwriting is the common case — runtime.json is rewritten on every start.
	if err := WriteFileAtomic(path, []byte("second"), 0o600); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	if b, _ := os.ReadFile(path); string(b) != "second" {
		t.Errorf("after overwrite = %q; want %q", b, "second")
	}
}

// runtime.json carries the daemon's auth token, so it must not be world
// readable. (Windows does not model POSIX bits, hence the skip.)
func TestWriteFileAtomicHonoursPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "secret.json")
	if err := WriteFileAtomic(path, []byte(`{"token":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Errorf("mode = %o; want 0600 — this file holds the daemon token", perm)
	}
}

// The temp file is an implementation detail: leaving one behind litters the
// data dir with a new dotfile on every write.
func TestWriteFileAtomicLeavesNoTempBehind(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.json")
	for i := 0; i < 5; i++ {
		if err := WriteFileAtomic(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("left a temp file behind: %s", e.Name())
		}
	}
	if len(entries) != 1 {
		t.Errorf("%d files in the dir; want just the target", len(entries))
	}
}

// A write into a directory that does not exist must fail cleanly rather than
// panic — this is what a data dir removed underneath a running daemon looks
// like.
func TestWriteFileAtomicFailsOnMissingDir(t *testing.T) {
	err := WriteFileAtomic(filepath.Join(t.TempDir(), "nope", "f.json"), []byte("x"), 0o600)
	if err == nil {
		t.Error("writing into a nonexistent directory succeeded; want an error")
	}
}

// The point of the whole function: a reader must see either the old contents
// or the new ones, never a partial write. Concurrent writers of differently
// sized payloads would expose a torn file immediately.
func TestWriteFileAtomicNeverExposesAPartialFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.json")
	small := []byte(strings.Repeat("a", 64))
	large := []byte(strings.Repeat("b", 64<<10))
	if err := WriteFileAtomic(path, small, 0o600); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})

	// Readers: every observation must be exactly one of the two payloads.
	var bad []string
	var mu sync.Mutex
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				b, err := os.ReadFile(path)
				if err != nil {
					continue // a rename window on some platforms; not a tear
				}
				if len(b) != len(small) && len(b) != len(large) {
					mu.Lock()
					bad = append(bad, string(rune(len(b))))
					mu.Unlock()
					return
				}
			}
		}()
	}
	// Writers alternate sizes.
	for i := 0; i < 30; i++ {
		payload := small
		if i%2 == 0 {
			payload = large
		}
		if err := WriteFileAtomic(path, payload, 0o600); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	close(stop)
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if len(bad) > 0 {
		t.Errorf("%d readers saw a partially written file", len(bad))
	}
}

// Load must survive whatever is on disk: the config file is user-editable, and
// a syntax error there should not stop the daemon from starting.
func TestLoadToleratesABadFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Either a clean error or defaults are acceptable; a panic is not.
	_, _ = Load(dir)
}

// A round trip through the runtime file, which is the shim's only way to find
// the daemon.
func TestRuntimeRoundTrip(t *testing.T) {
	dir := t.TempDir()
	in := Runtime{Port: 4173, Token: "tok", PID: 42, Version: "v1"}
	if err := WriteRuntime(dir, in); err != nil {
		t.Fatal(err)
	}
	got, err := ReadRuntime(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Port != in.Port || got.Token != in.Token || got.PID != in.PID {
		t.Errorf("round trip = %+v; want %+v", got, in)
	}
	if err := RemoveRuntime(dir); err != nil {
		t.Fatalf("RemoveRuntime: %v", err)
	}
	if _, err := ReadRuntime(dir); err == nil {
		t.Error("runtime.json still readable after removal")
	}
	// Removing an absent file is what a second shutdown does; it must not error.
	if err := RemoveRuntime(dir); err != nil {
		t.Errorf("second RemoveRuntime = %v; want nil", err)
	}
}

// CAPROCK_DATA_DIR is how every test in this repo — and every user running two
// daemons — keeps its state separate. If it stopped being honoured, tests would
// start writing into the developer's real data dir.
func TestDataDirFollowsTheEnvironment(t *testing.T) {
	want := t.TempDir()
	t.Setenv(EnvDataDir, want)
	got, err := DataDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Clean(want) {
		t.Errorf("DataDir = %q; want the value of %s (%q)", got, EnvDataDir, want)
	}
}

// With no override it falls back to the OS config dir, which must be an
// absolute path Caprock can create.
func TestDataDirFallsBackToTheOSLocation(t *testing.T) {
	t.Setenv(EnvDataDir, "")
	got, err := DataDir()
	if err != nil {
		t.Fatal(err)
	}
	if got == "" || !filepath.IsAbs(got) {
		t.Errorf("DataDir = %q; want an absolute path", got)
	}
	if !strings.Contains(got, "caprock") {
		t.Errorf("DataDir = %q; want it under a caprock directory", got)
	}
}

// The data dir holds the token and the database, so it is created 0700 — not
// world readable.
func TestEnsureDataDirCreatesItPrivately(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "nested", "caprock")
	t.Setenv(EnvDataDir, dir)

	got, err := EnsureDataDir()
	if err != nil {
		t.Fatalf("EnsureDataDir: %v", err)
	}
	if got != dir {
		t.Errorf("EnsureDataDir = %q; want %q", got, dir)
	}
	fi, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("the directory was not created: %v", err)
	}
	if !fi.IsDir() {
		t.Fatal("not a directory")
	}
	if runtime.GOOS != "windows" {
		if perm := fi.Mode().Perm(); perm != 0o700 {
			t.Errorf("mode = %o; want 0700 — this dir holds the token and database", perm)
		}
	}
	// Calling it again on an existing dir is the normal path on every start.
	if _, err := EnsureDataDir(); err != nil {
		t.Errorf("second EnsureDataDir = %v; want nil", err)
	}
}
