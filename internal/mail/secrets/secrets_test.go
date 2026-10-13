package secrets

import (
	"context"
	"encoding/base64"
	"errors"
	"path/filepath"
	"slices"
	"testing"
)

// A fake `security`: items by service+account, the keychain path recorded.
type fakeSecurity struct {
	items map[string]string
	argv  [][]string
}

func (f *fakeSecurity) run(_ context.Context, args ...string) (string, int, error) {
	f.argv = append(f.argv, args)
	at := func(flag string) string {
		if i := slices.Index(args, flag); i >= 0 && i+1 < len(args) {
			return args[i+1]
		}
		return ""
	}
	k := at("-s") + "/" + at("-a")
	switch args[0] {
	case "find-generic-password":
		v, ok := f.items[k]
		if !ok {
			return "", 44, errors.New("not found")
		}
		return v + "\n", 0, nil
	case "add-generic-password":
		f.items[k] = at("-w")
		return "", 0, nil
	case "delete-generic-password":
		if _, ok := f.items[k]; !ok {
			return "", 44, errors.New("not found")
		}
		delete(f.items, k)
		return "", 0, nil
	}
	return "", 1, errors.New("unexpected")
}

// Every call names the keychain file (no "Keychain Not Found" dialog), each
// account is its own item, and a password an earlier build saved through
// go-keyring (base64 with its prefix) is still read.
func TestMacKeychainNamesTheFileAndReadsOldPasswords(t *testing.T) {
	f := &fakeSecurity{items: map[string]string{
		"dev.caprock.mail/account-7": goKeyringPrefix + base64.StdEncoding.EncodeToString([]byte("old pass")),
	}}
	k := MacKeychain{Path: "/Users/x/Library/Keychains/login.keychain-db", Run: f.run}

	if got, err := k.Get(7); err != nil || got != "old pass" {
		t.Fatalf("old password = %q, %v", got, err)
	}
	if _, err := k.Get(8); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing = %v, want ErrNotFound", err)
	}
	if err := k.Set(8, "new pass"); err != nil {
		t.Fatal(err)
	}
	if got, _ := k.Get(8); got != "new pass" {
		t.Fatalf("new password = %q", got)
	}
	if err := k.Delete(8); err != nil {
		t.Fatal(err)
	}
	if err := k.Delete(8); err != nil {
		t.Fatalf("deleting a missing item: %v", err)
	}
	for _, a := range f.argv {
		if a[len(a)-1] != k.Path {
			t.Fatalf("security %v does not name the keychain file", a)
		}
	}
}

// CAPROCK_SECRET_STORE=file keeps passwords in the 0600 file and runs nothing.
func TestDefaultFileStore(t *testing.T) {
	t.Setenv("CAPROCK_SECRET_STORE", "file")
	dir := t.TempDir()
	s := Default(dir)
	if err := s.Set(1, "pw"); err != nil {
		t.Fatal(err)
	}
	f := &File{Path: filepath.Join(dir, "mail-secrets.json")}
	if got, err := f.Get(1); err != nil || got != "pw" {
		t.Fatalf("file has %q, %v", got, err)
	}
}
