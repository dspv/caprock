package hooks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const userSettings = `{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": ["Bash(git *)"],
    "deny": []
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {"type": "command", "command": "/usr/local/bin/my-guard.sh"}
        ]
      }
    ],
    "Notification": [
      {"hooks": [{"type": "command", "command": "say done"}]}
    ]
  },
  "model": "opus",
  "zzz_last": 1
}
`

func write(t *testing.T, dir, content string) string {
	t.Helper()
	p := filepath.Join(dir, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestInstallIsNonDestructiveAndUninstallReverts(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, userSettings)
	shim := filepath.Join(dir, "Application Support", "caprock", "caprock-hook")

	backup, err := Install(p, shim)
	if err != nil {
		t.Fatal(err)
	}
	if backup == "" {
		t.Fatal("expected a backup path")
	}
	if b, _ := os.ReadFile(backup); string(b) != userSettings {
		t.Fatal("backup differs from original")
	}
	after, _ := os.ReadFile(p)
	s := string(after)
	// Every foreign key/value survives, in order.
	for _, needle := range []string{`"$schema"`, `"permissions"`, `"Bash(git *)"`, `my-guard.sh`, `say done`, `"model": "opus"`, `"zzz_last": 1`} {
		if !strings.Contains(s, needle) {
			t.Errorf("lost %s:\n%s", needle, s)
		}
	}
	if strings.Index(s, `"$schema"`) > strings.Index(s, `"permissions"`) || strings.Index(s, `"model"`) > strings.Index(s, `"zzz_last"`) {
		t.Errorf("key order changed:\n%s", s)
	}
	// The user's PreToolUse guard is still first; ours appended.
	if strings.Index(s, "my-guard.sh") > strings.Index(s, "caprock-hook") {
		t.Errorf("our entry was not appended after the user's:\n%s", s)
	}
	// Path with spaces is quoted.
	if !strings.Contains(s, `\"`+shim+`\"`) && !strings.Contains(s, `"\"`) {
		t.Errorf("shim path with spaces not quoted:\n%s", s)
	}
	st, err := Inspect(p, shim)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Installed) != len(Events) || len(st.Missing) != 0 {
		t.Fatalf("status after install: %+v", st)
	}
	// Idempotent: second install writes nothing and makes no second backup.
	b2, err := Install(p, shim)
	if err != nil || b2 != "" {
		t.Fatalf("second install: backup=%q err=%v", b2, err)
	}
	again, _ := os.ReadFile(p)
	if string(again) != s {
		t.Fatal("second install changed the file")
	}
	matches, _ := filepath.Glob(p + ".caprock-backup-*")
	if len(matches) != 1 {
		t.Fatalf("backups: %v", matches)
	}

	removed, err := Uninstall(p, shim)
	if err != nil || !removed {
		t.Fatalf("uninstall: %v %v", removed, err)
	}
	reverted, _ := os.ReadFile(p)
	// Semantically identical to the original (re-rendered with the same indent).
	want, _ := MarshalIndent(mustParse(t, userSettings))
	if string(reverted) != string(want) {
		t.Fatalf("uninstall did not revert cleanly:\n--- got\n%s\n--- want\n%s", reverted, want)
	}
	if removed, _ := Uninstall(p, shim); removed {
		t.Fatal("second uninstall removed something")
	}
}

func TestInstallCreatesMissingFileAndUninstallDropsEmptyHooks(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, ".claude", "settings.json")
	shim := filepath.Join(dir, "caprock-hook")
	backup, err := Install(p, shim)
	if err != nil {
		t.Fatal(err)
	}
	if backup != "" {
		t.Fatalf("no original ⇒ no backup, got %q", backup)
	}
	b, _ := os.ReadFile(p)
	if !strings.Contains(string(b), `"SessionStart"`) || !strings.Contains(string(b), `"timeout": 5`) {
		t.Fatalf("content:\n%s", b)
	}
	if _, err := Uninstall(p, shim); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(p)
	if strings.TrimSpace(string(b)) != "{}" {
		t.Fatalf("expected empty object after uninstall, got %q", b)
	}
}

func TestInstallRefusesUnparsableSettings(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, `{"hooks": {`)
	if _, err := Install(p, "/x/caprock-hook"); err == nil {
		t.Fatal("expected error on unparsable settings")
	}
	if b, _ := os.ReadFile(p); string(b) != `{"hooks": {` {
		t.Fatal("unparsable file was modified")
	}
}

func TestUninstallRecognisesMovedShim(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/old/place/caprock-hook","timeout":5}]}]}}`)
	removed, err := Uninstall(p, "/new/place/caprock-hook")
	if err != nil || !removed {
		t.Fatalf("moved shim not removed: %v %v", removed, err)
	}
}

func TestOrderedJSONRoundTrip(t *testing.T) {
	src := `{"b":1,"a":[true,null,{"z":"q","y":2.5}],"c":{"n":12345678901234567890}}`
	v := mustParse(t, src)
	out, err := MarshalIndent(v)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if strings.Index(s, `"b"`) > strings.Index(s, `"a"`) || strings.Index(s, `"z"`) > strings.Index(s, `"y"`) {
		t.Fatalf("order lost:\n%s", s)
	}
	if !strings.Contains(s, "12345678901234567890") {
		t.Fatalf("big number mangled:\n%s", s)
	}
	if _, err := ParseOrdered([]byte(`{"a":1} trailing`)); err == nil {
		t.Fatal("trailing data accepted")
	}
}

// Events is a contract: the shim registers for exactly these 8 Claude Code hook
// events. Pinning them here means dropping or renaming one fails a test instead
// of silently shrinking what Caprock observes.
func TestEventsListIsPinned(t *testing.T) {
	want := []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "PreCompact", "StopFailure"}
	if len(Events) != len(want) {
		t.Fatalf("event count changed: got %d (%v), want %d", len(Events), Events, len(want))
	}
	for i, e := range want {
		if Events[i] != e {
			t.Fatalf("event %d: got %q, want %q", i, Events[i], e)
		}
	}
}

func mustParse(t *testing.T, s string) any {
	t.Helper()
	v, err := ParseOrdered([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return v
}
