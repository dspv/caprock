package hooks

import "testing"

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
