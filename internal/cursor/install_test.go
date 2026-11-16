package cursor

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// orcaHooks is a real hooks.json: the owner's, with Orca's eight hooks in it,
// the home directory renamed.
func orcaHooks(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "hooks-orca.json"))
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "hooks.json")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// decoded is a hooks file as plain JSON values, so two files compare by
// meaning: an install may re-indent, never change what anything says.
func decoded(t *testing.T, p string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil {
		t.Fatal(err)
	}
	return m
}

const shim = "/data/caprock-hook"

func TestInstallKeepsOtherToolsHooksAndIsIdempotent(t *testing.T) {
	p := orcaHooks(t)
	before := decoded(t, p)
	st, err := InstallHooks(p, shim)
	if err != nil {
		t.Fatal(err)
	}
	if !st.Installed || st.Others != 8 {
		t.Fatalf("status after install: %+v", st)
	}
	once, _ := os.ReadFile(p)
	if _, err := InstallHooks(p, shim); err != nil {
		t.Fatal(err)
	}
	twice, _ := os.ReadFile(p)
	if !bytes.Equal(once, twice) {
		t.Fatal("a second install changed the file")
	}
	after := decoded(t, p)
	hooks := after["hooks"].(map[string]any)
	for ev, list := range before["hooks"].(map[string]any) {
		got := hooks[ev].([]any)
		// Orca's entry stays first and unchanged; ours, where we register
		// for that event, comes after it.
		if !reflect.DeepEqual(got[0], list.([]any)[0]) {
			t.Errorf("%s: Orca's entry changed: %v", ev, got[0])
		}
	}
	for _, ev := range HookEvents {
		list := hooks[ev].([]any)
		last := list[len(list)-1].(map[string]any)
		if last["command"] != `"/data/caprock-hook" cursor` {
			t.Errorf("%s: our command is %v", ev, last["command"])
		}
	}
	// Never on a permission hook: an answer there decides.
	for _, ev := range []string{"preToolUse", "beforeShellExecution", "beforeMCPExecution"} {
		for _, e := range hooks[ev].([]any) {
			if isOurs(e.(map[string]any)["command"].(string)) {
				t.Errorf("registered on permission hook %s", ev)
			}
		}
	}
	if _, err := os.Stat(p + ".caprock-backup"); err != nil {
		t.Error("no backup of the user's file")
	}
}

func TestUninstallRestoresTheFileByMeaning(t *testing.T) {
	p := orcaHooks(t)
	before := decoded(t, p)
	if _, err := InstallHooks(p, shim); err != nil {
		t.Fatal(err)
	}
	st, err := UninstallHooks(p)
	if err != nil {
		t.Fatal(err)
	}
	if st.Installed || len(st.Missing) != len(HookEvents) || st.Others != 8 {
		t.Fatalf("status after uninstall: %+v", st)
	}
	if after := decoded(t, p); !reflect.DeepEqual(before, after) {
		t.Fatalf("uninstall did not give the user's file back:\n%v\n%v", before, after)
	}
	// Byte for byte, too: Orca's commands carry > and &, which a plain
	// json.Marshal rewrites as \u003e and \u0026.
	orig, _ := os.ReadFile(filepath.Join("testdata", "hooks-orca.json"))
	got, _ := os.ReadFile(p)
	if !bytes.Equal(bytes.TrimSpace(orig), bytes.TrimSpace(got)) {
		t.Fatalf("uninstall changed the bytes of the user's file:\n%s", got)
	}
}

func TestInstallCreatesAFileWithAVersion(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "hooks.json")
	if _, err := InstallHooks(p, shim); err != nil {
		t.Fatal(err)
	}
	m := decoded(t, p)
	if m["version"] != json.Number("1") {
		t.Fatalf("version = %v", m["version"])
	}
}

func TestAMovedDataDirReplacesRatherThanDoubles(t *testing.T) {
	p := orcaHooks(t)
	if _, err := InstallHooks(p, "/old/caprock-hook"); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallHooks(p, `C:\Users\x\AppData\Roaming\caprock\caprock-hook.exe`); err != nil {
		t.Fatal(err)
	}
	list := decoded(t, p)["hooks"].(map[string]any)["stop"].([]any)
	if len(list) != 2 {
		t.Fatalf("stop has %d entries, want Orca's and one of ours", len(list))
	}
	if got := list[1].(map[string]any)["command"]; got != `"C:/Users/x/AppData/Roaming/caprock/caprock-hook.exe" cursor` {
		t.Fatalf("command = %v", got)
	}
}

func TestAnUnreadableFileIsLeftAlone(t *testing.T) {
	p := filepath.Join(t.TempDir(), "hooks.json")
	if err := os.WriteFile(p, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallHooks(p, shim); err == nil {
		t.Fatal("installed over an unparsable file")
	}
	if b, _ := os.ReadFile(p); string(b) != "{not json" {
		t.Fatal("the file was changed")
	}
}

func TestIsOurs(t *testing.T) {
	for cmd, want := range map[string]bool{
		`"/a b/caprock-hook" cursor`:                 true,
		`"/usr/local/bin/caprock" hook cursor`:       true,
		`"C:/x/caprock-hook.exe" cursor`:             true,
		`"/a/caprock-hook"`:                          false,
		`/bin/sh -c 'orca-hook.sh'`:                  false,
		`"/a/not-caprock-hook" cursor`:               false,
		`/Users/someone/.orca/cursor-hook.sh cursor`: false,
	} {
		if got := isOurs(cmd); got != want {
			t.Errorf("isOurs(%q) = %v", cmd, got)
		}
	}
}
