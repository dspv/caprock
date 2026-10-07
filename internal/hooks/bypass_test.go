package hooks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBypassAcceptedMissingFile(t *testing.T) {
	ok, err := BypassAccepted(filepath.Join(t.TempDir(), "settings.json"))
	if err != nil || ok {
		t.Fatalf("missing file: got %v, %v; want false, nil", ok, err)
	}
}

func TestAcceptBypassKeepsEveryOtherKey(t *testing.T) {
	p := filepath.Join(t.TempDir(), "settings.json")
	orig := `{"model": "opus", "permissions": {"allow": ["Bash(ls)"]}, "skipDangerousModePermissionPrompt": false}`
	if err := os.WriteFile(p, []byte(orig), 0o600); err != nil {
		t.Fatal(err)
	}
	if ok, _ := BypassAccepted(p); ok {
		t.Fatal("false in the file read as accepted")
	}
	if _, err := AcceptBypass(p); err != nil {
		t.Fatal(err)
	}
	if ok, err := BypassAccepted(p); err != nil || !ok {
		t.Fatalf("after accept: %v, %v", ok, err)
	}
	b, _ := os.ReadFile(p)
	s := string(b)
	for _, want := range []string{`"model": "opus"`, `"Bash(ls)"`, `"skipDangerousModePermissionPrompt": true`} {
		if !strings.Contains(s, want) {
			t.Errorf("settings lost %s:\n%s", want, s)
		}
	}
	if strings.Index(s, `"model"`) > strings.Index(s, `"permissions"`) {
		t.Errorf("key order changed:\n%s", s)
	}
	// Idempotent: a second accept changes nothing and takes no backup.
	if backup, err := AcceptBypass(p); err != nil || backup != "" {
		t.Fatalf("second accept: %q, %v", backup, err)
	}
}

func TestAcceptBypassCreatesTheFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".claude", "settings.json")
	if _, err := AcceptBypass(p); err != nil {
		t.Fatal(err)
	}
	if ok, _ := BypassAccepted(p); !ok {
		t.Fatal("not accepted after accept on a fresh machine")
	}
}

func TestBypassAcceptedRefusesAnUnparsableFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(p, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := AcceptBypass(p); err == nil {
		t.Fatal("accept overwrote an unparsable settings.json")
	}
}
