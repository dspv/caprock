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

// An older version wrote the command with quotes around the whole string
// (`"…/caprock statusline"`). The shell resolves that as one filename that does
// not exist, so the status line printed nothing at all — silently, for as long
// as the entry survived. It has to be recognised as ours, or install treats it
// as a stranger's and leaves it broken forever.
func TestBrokenQuotingIsRecognisedAsOurs(t *testing.T) {
	good := `"/opt/homebrew/bin/caprock" statusline`
	for _, cs := range []string{
		`"/opt/homebrew/bin/caprock statusline"`,
		`"/usr/local/bin/caprock statusline --rich"`,
		`"C:\Users\Volas\scoop\apps\caprock\current\caprock.exe statusline"`,
		// A path with spaces in the broken form: neither the first nor the last
		// space is the boundary, which is why the split keys off `statusline`.
		`"/Users/My Name/bin/caprock statusline"`,
		`"/Users/My Name/bin/caprock statusline --rich"`,
	} {
		if !isOurStatusline(cs, good) {
			t.Errorf("broken quoting should still be ours: %q", cs)
		}
	}
	// Someone else's command in the same broken shape is still not ours.
	for _, cs := range []string{
		`"/usr/local/bin/ccusage statusline"`,
		`"/usr/local/bin/caprock hooks"`,
	} {
		if isOurStatusline(cs, good) {
			t.Errorf("should not be ours: %q", cs)
		}
	}
}

// brokenQuoting identifies only the unrunnable spelling — a correctly quoted
// path, or no quoting at all, is working and must not be flagged.
func TestBrokenQuoting(t *testing.T) {
	for _, cs := range []string{
		`"/opt/homebrew/bin/caprock statusline"`,
		`  "/opt/homebrew/bin/caprock statusline --rich"  `,
	} {
		if !brokenQuoting(cs) {
			t.Errorf("should be flagged broken: %q", cs)
		}
	}
	for _, cs := range []string{
		`"/opt/homebrew/bin/caprock" statusline`,
		`/opt/homebrew/bin/caprock statusline`,
		`caprock statusline`,
		`"/Users/My Name/bin/caprock" statusline`,
		`"/usr/local/bin/caprock"`, // quoted path alone, no space inside
	} {
		if brokenQuoting(cs) {
			t.Errorf("working command flagged broken: %q", cs)
		}
	}
}

// RepairStatusline rewrites only an entry of ours that cannot run, and leaves
// everything else — including a working entry of ours — exactly as it is.
func TestRepairStatusline(t *testing.T) {
	good := `"/opt/homebrew/bin/caprock" statusline`

	t.Run("repairs the broken form", func(t *testing.T) {
		sp := filepath.Join(t.TempDir(), "settings.json")
		if err := os.WriteFile(sp, []byte(
			`{"model":"opus","statusLine":{"type":"command","command":"\"/opt/homebrew/bin/caprock statusline\""}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		repaired, err := RepairStatusline(sp, good)
		if err != nil || !repaired {
			t.Fatalf("repair: %v %v", repaired, err)
		}
		got, _ := os.ReadFile(sp)
		if !strings.Contains(string(got), `\"/opt/homebrew/bin/caprock\" statusline`) {
			t.Fatalf("not rewritten to the runnable form: %s", got)
		}
		// The rest of the user's settings survive.
		if !strings.Contains(string(got), `"model"`) {
			t.Fatalf("lost the rest of settings.json: %s", got)
		}
		// Idempotent: a second pass has nothing to do.
		if again, err := RepairStatusline(sp, good); err != nil || again {
			t.Fatalf("second repair: %v %v", again, err)
		}
	})

	t.Run("leaves a working entry of ours alone", func(t *testing.T) {
		sp := filepath.Join(t.TempDir(), "settings.json")
		if _, err := InstallStatusline(sp, good); err != nil {
			t.Fatal(err)
		}
		if repaired, err := RepairStatusline(sp, good); err != nil || repaired {
			t.Fatalf("touched a working entry: %v %v", repaired, err)
		}
	})

	t.Run("never touches someone else's statusLine", func(t *testing.T) {
		sp := filepath.Join(t.TempDir(), "settings.json")
		// Broken in the same way, but not our program.
		if err := os.WriteFile(sp, []byte(
			`{"statusLine":{"type":"command","command":"\"/usr/local/bin/ccusage statusline\""}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if repaired, err := RepairStatusline(sp, good); err != nil || repaired {
			t.Fatalf("touched a foreign statusLine: %v %v", repaired, err)
		}
		got, _ := os.ReadFile(sp)
		if !strings.Contains(string(got), "ccusage") {
			t.Fatalf("foreign command lost: %s", got)
		}
	})

	t.Run("missing file and no statusLine are not errors", func(t *testing.T) {
		if r, err := RepairStatusline(filepath.Join(t.TempDir(), "settings.json"), good); err != nil || r {
			t.Fatalf("missing file: %v %v", r, err)
		}
		sp := filepath.Join(t.TempDir(), "settings.json")
		if err := os.WriteFile(sp, []byte(`{"model":"opus"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if r, err := RepairStatusline(sp, good); err != nil || r {
			t.Fatalf("no statusLine: %v %v", r, err)
		}
	})
}

// Settings → Status line: Off removes our entry and only ours; choosing Full
// or Short again puts it back, and never over a statusLine the user set.
func TestSetStatuslineOn(t *testing.T) {
	ours := `"/opt/homebrew/bin/caprock" statusline`

	t.Run("off removes ours, on puts it back", func(t *testing.T) {
		sp := filepath.Join(t.TempDir(), "settings.json")
		if err := os.WriteFile(sp, []byte(`{"model":"opus"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := InstallStatusline(sp, ours); err != nil {
			t.Fatal(err)
		}
		changed, err := SetStatuslineOn(sp, ours, false)
		if err != nil || !changed {
			t.Fatalf("off: %v %v", changed, err)
		}
		if _, present, _ := StatuslineInstalled(sp, ours); present {
			t.Fatal("off left a statusLine behind")
		}
		changed, err = SetStatuslineOn(sp, ours, true)
		if err != nil || !changed {
			t.Fatalf("on: %v %v", changed, err)
		}
		if mine, _, _ := StatuslineInstalled(sp, ours); !mine {
			t.Fatal("on did not re-install ours")
		}
		// On again is a no-op: Full and Short share the one entry.
		if changed, err := SetStatuslineOn(sp, ours, true); err != nil || changed {
			t.Fatalf("second on: %v %v", changed, err)
		}
		got, _ := os.ReadFile(sp)
		if !strings.Contains(string(got), `"model"`) {
			t.Fatalf("lost the rest of settings.json: %s", got)
		}
	})

	t.Run("a flagged entry of ours is still ours", func(t *testing.T) {
		sp := filepath.Join(t.TempDir(), "settings.json")
		if _, err := InstallStatusline(sp, ours+" --rich"); err != nil {
			t.Fatal(err)
		}
		if changed, err := SetStatuslineOn(sp, ours, false); err != nil || !changed {
			t.Fatalf("off: %v %v", changed, err)
		}
	})

	t.Run("the user's own statusLine is never touched", func(t *testing.T) {
		sp := filepath.Join(t.TempDir(), "settings.json")
		theirs := `{"statusLine":{"type":"command","command":"npx ccusage statusline"}}`
		if err := os.WriteFile(sp, []byte(theirs), 0o600); err != nil {
			t.Fatal(err)
		}
		for _, on := range []bool{false, true, false} {
			if changed, err := SetStatuslineOn(sp, ours, on); err != nil || changed {
				t.Fatalf("on=%v changed the user's statusLine: %v %v", on, changed, err)
			}
		}
		got, _ := os.ReadFile(sp)
		if string(got) != theirs {
			t.Fatalf("user's settings rewritten: %s", got)
		}
	})

	t.Run("no settings file: off is a no-op, on creates it", func(t *testing.T) {
		sp := filepath.Join(t.TempDir(), "settings.json")
		if changed, err := SetStatuslineOn(sp, ours, false); err != nil || changed {
			t.Fatalf("off: %v %v", changed, err)
		}
		if _, err := os.Stat(sp); !os.IsNotExist(err) {
			t.Fatalf("off created a file: %v", err)
		}
		if changed, err := SetStatuslineOn(sp, ours, true); err != nil || !changed {
			t.Fatalf("on: %v %v", changed, err)
		}
	})
}
