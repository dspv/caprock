package hooks

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// The statusLine command is registered separately from hooks: it feeds Claude
// Code's rate-limit windows (5h/7d, Pro/Max) to the daemon so the Cost screen can
// show plan limits. Like the hook shim it is fire-and-forget and can never break
// the session. See internal/statusline and .ai/03-contracts.md § Statusline.

// StatuslineInstalled reports whether settings.json already has a statusLine
// command that points at our binary (`… statusline`). A different statusLine
// command (the user's own) is left alone and reported as not-ours.
func StatuslineInstalled(settingsPath, cmdPath string) (ours bool, present bool, err error) {
	root, err := readSettings(settingsPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, false, nil
		}
		return false, false, err
	}
	v, ok := root.Get("statusLine")
	if !ok {
		return false, false, nil
	}
	obj, ok := v.(*Object)
	if !ok {
		return false, true, nil
	}
	c, _ := obj.Get("command")
	cs, _ := c.(string)
	if cs == "" {
		return false, true, nil
	}
	return isOurStatusline(cs, cmdPath), true, nil
}

// isOurStatusline matches our statusline command in either form: the bare/quoted
// path plus the `statusline` subcommand (`…/caprock statusline`), or any command
// whose first token's base name is caprock and whose second token is statusline.
func isOurStatusline(cs, cmdPath string) bool {
	trimmed := strings.Trim(cs, `"`)
	if trimmed == cmdPath || cs == cmdPath {
		return true
	}
	fields := strings.Fields(trimmed)
	if len(fields) == 2 && fields[1] == "statusline" {
		if b := filepath.Base(fields[0]); b == "caprock" || b == "caprock.exe" {
			return true
		}
	}
	return false
}

// InstallStatusline sets settings.json's statusLine to our command, backing the
// file up once. It refuses to clobber a statusLine the user set to something
// else — callers should check StatuslineInstalled and only offer to install when
// nothing (or our own) is present. Returns the backup path (empty if no change).
func InstallStatusline(settingsPath, cmdPath string) (backup string, err error) {
	root, err := readSettings(settingsPath)
	if err != nil {
		return "", err
	}
	if v, ok := root.Get("statusLine"); ok {
		if obj, ok := v.(*Object); ok {
			if c, _ := obj.Get("command"); c != nil {
				if cs, _ := c.(string); cs != "" && isOurStatusline(cs, cmdPath) {
					return "", nil // already ours — idempotent no-op
				}
			}
		}
	}
	sl := NewObject()
	sl.Set("type", "command")
	sl.Set("command", quoteIfSpaces(cmdPath))
	root.Set("statusLine", sl)
	if backup, err = backupOnce(settingsPath); err != nil {
		return "", err
	}
	return backup, writeSettings(settingsPath, root)
}

// UninstallStatusline removes the statusLine only if it is ours, leaving a
// user-set statusLine untouched. Returns whether anything was removed.
func UninstallStatusline(settingsPath, cmdPath string) (removed bool, err error) {
	root, err := readSettings(settingsPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	v, ok := root.Get("statusLine")
	if !ok {
		return false, nil
	}
	obj, ok := v.(*Object)
	if !ok {
		return false, nil
	}
	c, _ := obj.Get("command")
	cs, _ := c.(string)
	if cs == "" || !isOurStatusline(cs, cmdPath) {
		return false, nil
	}
	root.Delete("statusLine")
	if _, err := backupOnce(settingsPath); err != nil {
		return false, err
	}
	return true, writeSettings(settingsPath, root)
}
