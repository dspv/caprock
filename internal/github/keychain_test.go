package github

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"testing"
	"time"
)

// The Keychain store against the real `security` tool, under a throwaway
// service name it deletes. Opt-in (CAPROCK_KEYCHAIN_TEST=1): a CI runner's
// keychain may be locked, and a developer's is theirs.
func TestKeychainStoreRoundTrip(t *testing.T) {
	if runtime.GOOS != "darwin" || os.Getenv("CAPROCK_KEYCHAIN_TEST") != "1" {
		t.Skip("macOS with CAPROCK_KEYCHAIN_TEST=1 only")
	}
	k := Keychain{Service: fmt.Sprintf("%s.test.%d", KeychainService, time.Now().UnixNano())}
	ctx := context.Background()
	t.Cleanup(func() { _ = k.Delete(ctx) })
	if got, err := k.Get(ctx); err != nil || got != "" {
		t.Fatalf("empty: %q %v", got, err)
	}
	if err := k.Set(ctx, "ghp_test_value"); err != nil {
		t.Fatal(err)
	}
	if err := k.Set(ctx, "ghp_test_value2"); err != nil { // -U updates in place
		t.Fatal(err)
	}
	if got, err := k.Get(ctx); err != nil || got != "ghp_test_value2" {
		t.Fatalf("read back %q %v", got, err)
	}
	if err := k.Delete(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := k.Get(ctx); got != "" {
		t.Fatalf("still there after delete: %q", got)
	}
	if err := k.Delete(ctx); err != nil {
		t.Fatalf("deleting nothing: %v", err)
	}
}

// The file store is 0600 and forgets cleanly.
func TestFileStore(t *testing.T) {
	f := File{Path: t.TempDir() + "/" + TokenFile}
	ctx := context.Background()
	if err := f.Set(ctx, "ghp_x"); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.Get(ctx); got != "ghp_x" {
		t.Fatalf("%q", got)
	}
	if runtime.GOOS != "windows" {
		if st, _ := os.Stat(f.Path); st.Mode().Perm() != 0o600 {
			t.Fatalf("mode %v", st.Mode())
		}
	}
	if err := f.Delete(ctx); err != nil {
		t.Fatal(err)
	}
	if got, err := f.Get(ctx); got != "" || err != nil {
		t.Fatalf("%q %v", got, err)
	}
}

// The GitHub CLI source runs `gh auth token` and says how to log in when it fails.
func TestGHCLISource(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script stand-in")
	}
	dir := t.TempDir()
	ok := dir + "/gh"
	if err := os.WriteFile(ok, []byte("#!/bin/sh\n[ \"$1 $2 $3 $4\" = \"auth token --hostname github.com\" ] && echo gho_from_cli && exit 0\nexit 3\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if tok, err := (GHCLI{Bin: ok}).Token(context.Background()); err != nil || tok != "gho_from_cli" {
		t.Fatalf("%q %v", tok, err)
	}
	bad := dir + "/gh-bad"
	if err := os.WriteFile(bad, []byte("#!/bin/sh\necho 'no oauth token found for github.com' >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := (GHCLI{Bin: bad}).Token(context.Background()); err == nil || err.Error() != "the GitHub CLI has no login for github.com (no oauth token found for github.com); run `gh auth login` in a terminal" {
		t.Fatalf("%v", err)
	}
	if (GHCLI{Env: func() []string { return []string{"PATH=" + t.TempDir()} }}).Found() && runtime.GOOS == "linux" {
		t.Log("gh found outside PATH (a system install)")
	}
}
