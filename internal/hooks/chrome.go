package hooks

import (
	"errors"
	"os"
)

// ChromeDefaultKey is what Claude Code's `/chrome` dialog writes for its
// "Enabled by default" row: claudeInChromeDefaultEnabled, true, in its global
// config (~/.claude.json, or .claude.json in CLAUDE_CONFIG_DIR). Read from the
// Claude Code 2.1.332 bundle on 2026-11-26: the dialog's own schema describes
// enabled_by_default as `The "Enabled by default" setting
// (claudeInChromeDefaultEnabled in the global config)`, and a session started
// without --chrome connects Claude in Chrome when that key is true. A session
// Claude Code counts as remote ignores it (its own log line says so).
const ChromeDefaultKey = "claudeInChromeDefaultEnabled"

// ChromeDefault reports whether Claude in Chrome is on by default in the
// global config at path. A missing file is "no", not an error.
func ChromeDefault(path string) (bool, error) {
	root, err := readSettings(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	v, _ := root.Get(ChromeDefaultKey)
	b, _ := v.(bool)
	return b, nil
}

// EnableChromeDefault turns "Enabled by default" on as the `/chrome` dialog
// does, keeping every other key in place and order (the ordered codec: the
// file is Claude Code's, large, and holds integers past 2^53). A file that
// does not parse is never written. Nothing is written when it is on already.
func EnableChromeDefault(path string) error {
	root, err := readSettings(path)
	if err != nil {
		return err
	}
	if v, _ := root.Get(ChromeDefaultKey); v == true {
		return nil
	}
	root.Set(ChromeDefaultKey, true)
	return writeSettings(path, root)
}
