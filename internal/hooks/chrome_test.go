package hooks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestChromeDefault(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".claude.json")
	if on, err := ChromeDefault(p); err != nil || on {
		t.Fatalf("missing file: %v %v", on, err)
	}
	// Other keys keep their place and an integer past 2^53 its digits.
	body := `{"numStartups": 9007199254740993, "projects": {"/a": {"hasTrustDialogAccepted": true}}, "claudeInChromeDefaultEnabled": false}`
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if on, _ := ChromeDefault(p); on {
		t.Fatal("false read as on")
	}
	if err := EnableChromeDefault(p); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	s := string(b)
	if !strings.Contains(s, "9007199254740993") || strings.Index(s, "numStartups") > strings.Index(s, "projects") {
		t.Fatalf("other keys changed: %s", s)
	}
	if on, _ := ChromeDefault(p); !on {
		t.Fatalf("not on after Enable: %s", s)
	}
}

func TestEnableChromeDefaultRefusesAnUnparsableFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".claude.json")
	if err := os.WriteFile(p, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnableChromeDefault(p); err == nil {
		t.Fatal("wrote over a file it could not read")
	}
	if b, _ := os.ReadFile(p); string(b) != "{not json" {
		t.Fatalf("file changed: %q", b)
	}
}
