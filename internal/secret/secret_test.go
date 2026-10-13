package secret

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

var testItem = Item{Service: "dev.caprock.deepseek", Label: "Caprock DeepSeek API key", File: "deepseek-api-key", Noun: "key"}

// The item's service and label reach `security`, the value goes as an
// argument, and the keychain file is always named last.
func TestKeychainArgvPerItem(t *testing.T) {
	sec := &fakeSecurity{}
	k := Keychain{Service: testItem.Service, Label: testItem.Label, Path: "/k/login.keychain-db", Run: sec.run}
	if err := k.Set(context.Background(), "sk-x"); err != nil {
		t.Fatal(err)
	}
	want := [][]string{{"add-generic-password", "-U", "-s", testItem.Service, "-a", Account, "-l", testItem.Label, "-w", "sk-x", k.Path}}
	if !reflect.DeepEqual(sec.calls, want) {
		t.Fatalf("argv %q", sec.calls)
	}
}

// Windows and Linux, and CAPROCK_SECRET_STORE=file anywhere: a 0600 file
// named for the item in the data directory, and Locate gives its path.
func TestDefaultIsTheFileOffMacOS(t *testing.T) {
	data := t.TempDir()
	if runtime.GOOS == "darwin" {
		t.Setenv(EnvStore, "file")
	} else {
		t.Setenv(EnvStore, "")
	}
	st := Default(data, testItem, t.TempDir())
	f, ok := st.(File)
	if !ok {
		t.Fatalf("store %T", st)
	}
	want := filepath.Join(data, "deepseek-api-key")
	if f.Path != want {
		t.Fatalf("path %q want %q", f.Path, want)
	}
	if w := Locate(st); w.Kind != "file" || w.Path != want {
		t.Fatalf("where %+v", w)
	}
	ctx := context.Background()
	if err := st.Set(ctx, "sk-file"); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(want); fi.Mode().Perm() != 0o600 {
			t.Fatalf("mode %v", fi.Mode())
		}
	}
	if got, _ := st.Get(ctx); got != "sk-file" {
		t.Fatalf("%q", got)
	}
	if err := st.Delete(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(want); !os.IsNotExist(err) {
		t.Fatal("Remove left the file")
	}
}

// A keychain that refuses puts the value in the file, and the note names it
// with the item's noun; Locate then reports the file.
func TestFallbackNoteNamesTheItem(t *testing.T) {
	sec := &fakeSecurity{code: 51, err: errors.New("security add-generic-password: User interaction is not allowed.")}
	data := t.TempDir()
	f := &Fallback{Keychain: Keychain{Service: testItem.Service, Label: testItem.Label, Path: "/k/login.keychain-db", Run: sec.run}, File: File{Path: filepath.Join(data, testItem.File)}, Noun: "key"}
	if err := f.Set(context.Background(), "sk-f"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.Note(), "so the key is in a file") {
		t.Fatalf("note %q", f.Note())
	}
	if w := Locate(f); w.Kind != "file" || w.Path != f.File.Path || w.Note == "" {
		t.Fatalf("where %+v", w)
	}
	sec.code, sec.err = 0, nil
	if err := f.Set(context.Background(), "sk-k"); err != nil {
		t.Fatal(err)
	}
	if w := Locate(f); w.Kind != "keychain" || w.Path != "" {
		t.Fatalf("where %+v", w)
	}
}

// A macOS home without a login keychain uses the file, saying why.
func TestDefaultWithoutLoginKeychain(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the Keychain is macOS only")
	}
	t.Setenv(EnvStore, "")
	st := Default(t.TempDir(), testItem, t.TempDir())
	if w := Locate(st); w.Kind != "file" || !strings.Contains(w.Note, "No login keychain") || !strings.Contains(w.Note, "the key is") {
		t.Fatalf("where %+v", w)
	}
}

func TestLocateNil(t *testing.T) {
	if w := Locate(nil); w != (Where{}) {
		t.Fatalf("%+v", w)
	}
}
