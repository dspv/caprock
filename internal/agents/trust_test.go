package agents

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestTrustFolderPreacceptsAndPreserves(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// A pre-existing config with unrelated keys must survive untouched.
	cfg := filepath.Join(home, ".claude.json")
	orig := map[string]any{
		"someTopLevel": "keep-me",
		"projects": map[string]any{
			"/other": map[string]any{"hasTrustDialogAccepted": true, "note": "x"},
		},
	}
	b, _ := json.Marshal(orig)
	if err := os.WriteFile(cfg, b, 0o600); err != nil {
		t.Fatal(err)
	}

	dir := "/Users/x/repo"
	if err := trustFolder(dir); err != nil {
		t.Fatal(err)
	}

	var got map[string]any
	raw, _ := os.ReadFile(cfg)
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got["someTopLevel"] != "keep-me" {
		t.Fatalf("unrelated top-level key lost: %v", got["someTopLevel"])
	}
	projects := got["projects"].(map[string]any)
	if _, ok := projects["/other"]; !ok {
		t.Fatal("unrelated project entry lost")
	}
	entry, ok := projects[dir].(map[string]any)
	if !ok || entry["hasTrustDialogAccepted"] != true {
		t.Fatalf("folder not trusted: %v", projects[dir])
	}
}

func TestTrustFolderCreatesConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := trustFolder("/repo"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	_ = json.Unmarshal(raw, &got)
	entry := got["projects"].(map[string]any)["/repo"].(map[string]any)
	if entry["hasTrustDialogAccepted"] != true {
		t.Fatalf("not trusted: %v", entry)
	}
}

func TestTrustFolderRefusesUnparsableConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cfg := filepath.Join(home, ".claude.json")
	_ = os.WriteFile(cfg, []byte("{not json"), 0o600)
	if err := trustFolder("/repo"); err == nil {
		t.Fatal("should refuse to overwrite an unparsable config")
	}
	// The bad file is left as-is, not clobbered.
	raw, _ := os.ReadFile(cfg)
	if string(raw) != "{not json" {
		t.Fatalf("clobbered unparsable config: %q", raw)
	}
}
