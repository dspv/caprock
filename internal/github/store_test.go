package github

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// fakeSecurity records each `security` call; no test runs the real tool.
type fakeSecurity struct {
	calls [][]string
	out   string
	code  int
	err   error
}

func (f *fakeSecurity) run(_ context.Context, args ...string) (string, int, error) {
	f.calls = append(f.calls, append([]string{}, args...))
	return f.out, f.code, f.err
}

// Every Keychain call names the keychain file as its last argument, and the
// token goes as an argument, never through a shell.
func TestKeychainArgv(t *testing.T) {
	sec := &fakeSecurity{out: "ghp_x\n"}
	k := Keychain{Service: KeychainService, Path: "/Users/u/Library/Keychains/login.keychain-db", Run: sec.run}
	ctx := context.Background()
	if got, err := k.Get(ctx); err != nil || got != "ghp_x" {
		t.Fatalf("get %q %v", got, err)
	}
	if err := k.Set(ctx, "ghp_y"); err != nil {
		t.Fatal(err)
	}
	if err := k.Delete(ctx); err != nil {
		t.Fatal(err)
	}
	want := [][]string{
		{"find-generic-password", "-s", KeychainService, "-a", keychainAccount, "-w", k.Path},
		{"add-generic-password", "-U", "-s", KeychainService, "-a", keychainAccount, "-l", "Caprock GitHub token", "-w", "ghp_y", k.Path},
		{"delete-generic-password", "-s", KeychainService, "-a", keychainAccount, k.Path},
	}
	if !reflect.DeepEqual(sec.calls, want) {
		t.Fatalf("argv\n got %q\nwant %q", sec.calls, want)
	}
	sec.code, sec.err = securityNotFound, errors.New("not found")
	if got, err := k.Get(ctx); err != nil || got != "" {
		t.Fatalf("missing item: %q %v", got, err)
	}
	if err := k.Delete(ctx); err != nil {
		t.Fatalf("deleting nothing: %v", err)
	}
}

// Without a keychain file the Keychain refuses before running anything: a
// bare `security add-generic-password` is what opens "Keychain Not Found".
func TestKeychainWithoutPathRunsNothing(t *testing.T) {
	sec := &fakeSecurity{}
	k := Keychain{Service: KeychainService, Run: sec.run}
	ctx := context.Background()
	if err := k.Set(ctx, "ghp_y"); err == nil {
		t.Fatal("set without a keychain file succeeded")
	}
	if _, err := k.Get(ctx); err == nil {
		t.Fatal("get without a keychain file succeeded")
	}
	if len(sec.calls) != 0 {
		t.Fatalf("security ran: %q", sec.calls)
	}
}

// No login keychain: the token goes to the 0600 file, with a note, and no
// Keychain is built at all.
func TestDefaultStoreMissingKeychainFallsBack(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the Keychain is macOS only")
	}
	t.Setenv(EnvSecretStore, "")
	data := t.TempDir()
	st := DefaultStore(data, KeychainService, t.TempDir()) // a home with no Library/Keychains
	fw, ok := st.(FileWithNote)
	if !ok {
		t.Fatalf("store %T, want the file", st)
	}
	if !strings.Contains(fw.Note(), "No login keychain") || st.Kind() != "file" {
		t.Fatalf("note %q kind %q", fw.Note(), st.Kind())
	}
	if err := st.Set(context.Background(), "ghp_z"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(data, TokenFile)); strings.TrimSpace(string(b)) != "ghp_z" {
		t.Fatalf("file %q", b)
	}
	if _, ok := DefaultStore(data, KeychainService, "").(FileWithNote); !ok {
		t.Fatal("an unknown home must use the file")
	}
}

// A login keychain that exists gets its explicit path; CAPROCK_SECRET_STORE=file
// skips it.
func TestDefaultStoreKeychainPath(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the Keychain is macOS only")
	}
	home := t.TempDir()
	kc := filepath.Join(home, "Library", "Keychains", "login.keychain-db")
	if err := os.MkdirAll(filepath.Dir(kc), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(kc, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvSecretStore, "")
	fb, ok := DefaultStore(t.TempDir(), KeychainService, home).(*Fallback)
	if !ok || fb.Keychain.Path != kc {
		t.Fatalf("store %#v", fb)
	}
	t.Setenv(EnvSecretStore, "file")
	if _, ok := DefaultStore(t.TempDir(), KeychainService, home).(File); !ok {
		t.Fatal("CAPROCK_SECRET_STORE=file must use the file")
	}
}

// When `security` fails, the token lands in the file with a visible note,
// and reading and forgetting it work from there.
func TestFallbackWhenSecurityFails(t *testing.T) {
	sec := &fakeSecurity{code: 51, err: errors.New("security add-generic-password: User interaction is not allowed.")}
	data := t.TempDir()
	f := &Fallback{Keychain: Keychain{Service: KeychainService, Path: "/k/login.keychain-db", Run: sec.run}, File: File{Path: filepath.Join(data, TokenFile)}}
	ctx := context.Background()
	if err := f.Set(ctx, "ghp_f"); err != nil {
		t.Fatal(err)
	}
	if f.Kind() != "file" || !strings.Contains(f.Note(), "User interaction is not allowed") {
		t.Fatalf("kind %q note %q", f.Kind(), f.Note())
	}
	if got, err := f.Get(ctx); err != nil || got != "ghp_f" {
		t.Fatalf("get %q %v", got, err)
	}
	if err := f.Delete(ctx); err != nil && !strings.Contains(err.Error(), "User interaction") {
		t.Fatal(err)
	}
	if _, err := os.Stat(f.File.Path); !os.IsNotExist(err) {
		t.Fatalf("file kept after delete: %v", err)
	}
	// The Keychain working again: Set goes there and removes the file.
	sec.code, sec.err = 0, nil
	if err := f.File.Set(ctx, "old"); err != nil {
		t.Fatal(err)
	}
	if err := f.Set(ctx, "ghp_k"); err != nil {
		t.Fatal(err)
	}
	if f.Kind() != "keychain" || f.Note() != "" {
		t.Fatalf("kind %q note %q", f.Kind(), f.Note())
	}
	if _, err := os.Stat(f.File.Path); !os.IsNotExist(err) {
		t.Fatal("the file was not removed once the Keychain held the token")
	}
}

func TestHomeFromDSCache(t *testing.T) {
	out := "name: ds\npassword: ********\nuid: 501\ngid: 20\ndir: /Users/ds\nshell: /bin/zsh\ngecos: D S\n"
	if got := homeFromDSCache(out); got != "/Users/ds" {
		t.Fatalf("%q", got)
	}
	if got := homeFromDSCache("dir: relative\n"); got != "" {
		t.Fatalf("%q", got)
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
}
