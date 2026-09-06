package hooks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The statusLine command carried the same spaces-only quoting the hooks did, so
// on Windows it reached bash as `C:UsersVolasscoop...caprock.exe statusline`
// and failed exactly like every hook did — a user had to repair it by hand
// alongside the eight hook entries.
func TestStatuslineRecognisesEveryPathForm(t *testing.T) {
	const exe = `C:\Users\Volas\scoop\apps\caprock\current\caprock.exe`
	current := ShellCommand(exe) + " statusline"

	// What the fixed installer writes: forward slashes, quoted, argument out.
	if want := `"C:/Users/Volas/scoop/apps/caprock/current/caprock.exe" statusline`; current != want {
		t.Fatalf("statusline command = %q; want %q", current, want)
	}

	// Every form that could already sit in a user's settings must still be
	// recognised as ours, or an upgrade offers to install what is already there
	// — or silently replaces a line the user fixed by hand.
	for _, cs := range []string{
		current,
		exe + " statusline",        // pre-fix, path had no spaces
		`"` + exe + `" statusline`, // pre-fix, quoted because it did
		`C:/Users/Volas/scoop/apps/caprock/current/caprock.exe statusline`, // hand-fixed
	} {
		if !isOurStatusline(cs, current) {
			t.Errorf("not recognised as ours: %q", cs)
		}
	}
}

// The registered command may carry flags (`… statusline --rich`). Detection has
// to see through them, or install would offer to add a second entry and
// uninstall would refuse to remove what we wrote ourselves. What still marks a
// command as not ours is the program, not its arguments.
func TestIsOurStatuslineToleratesFlags(t *testing.T) {
	plain := "/usr/local/bin/caprock statusline"
	for _, cs := range []string{
		"/usr/local/bin/caprock statusline --rich",
		"/opt/caprock statusline --rich --width 100",
		`"/Users/My Name/bin/caprock" statusline --rich`,
	} {
		if !isOurStatusline(cs, plain) {
			t.Errorf("should be ours: %q", cs)
		}
	}
	for _, cs := range []string{
		"ccusage statusline",
		"/usr/local/bin/other-tool statusline --rich",
		"/usr/local/bin/caprock hooks", // a caprock, but not the statusline
	} {
		if isOurStatusline(cs, plain) {
			t.Errorf("should not be ours: %q", cs)
		}
	}
}

// RetargetStatusline switches our own entry between the plain and rich forms,
// and never touches a statusLine the user set to something else.
func TestRetargetStatusline(t *testing.T) {
	plain := "/usr/local/bin/caprock statusline"
	rich := plain + " --rich"

	t.Run("switches our own entry", func(t *testing.T) {
		sp := filepath.Join(t.TempDir(), "settings.json")
		if _, err := InstallStatusline(sp, plain); err != nil {
			t.Fatal(err)
		}
		changed, err := RetargetStatusline(sp, rich)
		if err != nil || !changed {
			t.Fatalf("retarget: changed=%v err=%v", changed, err)
		}
		if b, _ := os.ReadFile(sp); !strings.Contains(string(b), "--rich") {
			t.Fatalf("rich form not written: %s", b)
		}
		// Idempotent: the same target twice reports no change.
		if changed, err := RetargetStatusline(sp, rich); err != nil || changed {
			t.Fatalf("second retarget: changed=%v err=%v", changed, err)
		}
		// And back again.
		if changed, err := RetargetStatusline(sp, plain); err != nil || !changed {
			t.Fatalf("retarget back: changed=%v err=%v", changed, err)
		}
		if b, _ := os.ReadFile(sp); strings.Contains(string(b), "--rich") {
			t.Fatalf("rich form not removed: %s", b)
		}
	})

	t.Run("leaves a user statusLine alone", func(t *testing.T) {
		sp := filepath.Join(t.TempDir(), "settings.json")
		if err := os.WriteFile(sp, []byte(`{"statusLine":{"type":"command","command":"ccusage"}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		changed, err := RetargetStatusline(sp, rich)
		if err != nil || changed {
			t.Fatalf("user statusLine touched: changed=%v err=%v", changed, err)
		}
		if b, _ := os.ReadFile(sp); !strings.Contains(string(b), "ccusage") {
			t.Fatalf("user command lost: %s", b)
		}
	})

	t.Run("no settings file is not an error", func(t *testing.T) {
		if changed, err := RetargetStatusline(filepath.Join(t.TempDir(), "settings.json"), rich); err != nil || changed {
			t.Fatalf("missing file: changed=%v err=%v", changed, err)
		}
	})
}
