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

// isOurStatusline matches our statusline command however the path is quoted: an
// exact match, or a command that ends in the `statusline` subcommand whose
// program path's base name is caprock. It handles a quoted path with spaces
// (`"…/caprock" statusline`) as well as a bare path (`…/caprock statusline`).
func isOurStatusline(cs, cmdPath string) bool {
	if cs == cmdPath {
		return true
	}
	prog, sub, ok := splitCommand(cs)
	if !ok || sub != "statusline" {
		return false
	}
	b := filepath.Base(prog)
	return b == "caprock" || b == "caprock.exe"
}

// splitCommand splits a `program subcommand` string into its program path and
// the single subcommand, honoring a leading double-quoted path (which may
// contain spaces). Returns ok=false if the shape isn't `<prog> <one-word-sub>`.
func splitCommand(cs string) (prog, sub string, ok bool) {
	cs = strings.TrimSpace(cs)
	if strings.HasPrefix(cs, `"`) {
		end := strings.IndexByte(cs[1:], '"')
		if end < 0 {
			return "", "", false
		}
		prog = cs[1 : 1+end]
		rest := strings.TrimSpace(cs[2+end:])
		if rest == "" || strings.ContainsAny(rest, " \t") {
			return "", "", false
		}
		return prog, rest, true
	}
	fields := strings.Fields(cs)
	if len(fields) != 2 {
		return "", "", false
	}
	return fields[0], fields[1], true
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
	// cmdPath is the full command (`<path> statusline`) with any needed quoting on
	// the path already applied by the caller — store it verbatim. Quoting the whole
	// command here would wrap the subcommand into the quotes and break execution.
	sl.Set("command", cmdPath)
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
