package daemon

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/dspv/caprock/internal/agents"
)

// What a chip offers follows the command line: bypass by Shift+Tab only in a
// process started able to reach it, by restart otherwise.
func TestModesOfferedFollowTheCommandLine(t *testing.T) {
	plain := agents.ReadLaunch("claude --session-id x --permission-mode acceptEdits")
	if got := inSessionModes(plain); slices.Contains(got, agents.ModeBypass) {
		t.Fatalf("in session without the flag: %v", got)
	}
	if got := restartModes(plain); !slices.Contains(got, agents.ModeBypass) {
		t.Fatalf("restart without the flag: %v", got)
	}
	allowed := agents.ReadLaunch("claude --session-id x --permission-mode acceptEdits --allow-dangerously-skip-permissions")
	if got := inSessionModes(allowed); !slices.Contains(got, agents.ModeBypass) {
		t.Fatalf("in session with the flag: %v", got)
	}
	if got := restartModes(allowed); slices.Contains(got, agents.ModeBypass) {
		t.Fatalf("restart with the flag: %v", got)
	}
}

// The consent is read from the settings the session itself reads: a
// subscription's own directory when it runs on one.
func TestBypassConsentIsReadWhereTheSessionReadsIt(t *testing.T) {
	dir := t.TempDir()
	if claudeBypassConsented(dir) {
		t.Fatal("no settings file is no consent")
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"skipDangerousModePermissionPrompt": true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if !claudeBypassConsented(dir) {
		t.Fatal("the key Claude Code writes on \"Yes, I accept\" is consent")
	}
}
