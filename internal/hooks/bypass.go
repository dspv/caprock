package hooks

import (
	"errors"
	"os"
)

// BypassKey is the user setting Claude Code writes when someone answers
// "Yes, I accept" to its one-time bypass warning ("WARNING: Claude Code
// running in Bypass Permissions mode"). Until it is true, the first session
// started with --dangerously-skip-permissions opens on that warning, with
// "No, exit" selected — so Enter ends the session (ADR-041).
const BypassKey = "skipDangerousModePermissionPrompt"

// BypassAccepted reports whether the user has accepted Claude Code's bypass
// warning in their user settings. A missing file is "no", not an error.
func BypassAccepted(settingsPath string) (bool, error) {
	root, err := readSettings(settingsPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	v, _ := root.Get(BypassKey)
	b, _ := v.(bool)
	return b, nil
}

// AcceptBypass records the user's acceptance the way Claude Code's own
// dialog does — the same key, true, in user settings — after Caprock showed
// the same warning and the user accepted it there. The file is backed up
// once first, and every other key is kept in place and order.
func AcceptBypass(settingsPath string) (backup string, err error) {
	root, err := readSettings(settingsPath)
	if err != nil {
		return "", err
	}
	if v, _ := root.Get(BypassKey); v == true {
		return "", nil
	}
	root.Set(BypassKey, true)
	if backup, err = backupOnce(settingsPath); err != nil {
		return "", err
	}
	return backup, writeSettings(settingsPath, root)
}
