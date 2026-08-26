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
