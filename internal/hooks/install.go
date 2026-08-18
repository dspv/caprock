// Package hooks installs and removes the caprock-hook shim in Claude Code's
// user-level settings.json, non-destructively. See .ai/03-contracts.md § Hook shim.
package hooks

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/config"
)

// Events the shim registers for (Phase 0). Order is the order written.
var Events = []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "PreCompact", "StopFailure"}

// ShimTimeoutSeconds is the per-hook timeout written into settings.json. The
// shim itself exits within ~1s; 5s is headroom for a slow disk, and it bounds
// the Phase 2 Stop request-response (5s) too.
const ShimTimeoutSeconds = 5

// DefaultSettingsPath is ~/.claude/settings.json.
func DefaultSettingsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "settings.json"), nil
}

// Status describes what is registered.
type Status struct {
	SettingsPath string   `json:"settings_path"`
	ShimPath     string   `json:"shim_path"`
	Installed    []string `json:"installed"` // events with our entry present
	Missing      []string `json:"missing"`   // events from Events without our entry
	ShimExists   bool     `json:"shim_exists"`
}

// Complete reports whether every event is registered and the shim binary exists.
func (s Status) Complete() bool { return len(s.Missing) == 0 && s.ShimExists }

// Inspect reads settings.json and reports which events carry our shim.
func Inspect(settingsPath, shimPath string) (Status, error) {
	st := Status{SettingsPath: settingsPath, ShimPath: shimPath}
	if _, err := os.Stat(shimPath); err == nil {
		st.ShimExists = true
	}
	root, err := readSettings(settingsPath)
	if err != nil {
		return st, err
	}
	hooks := hooksObject(root, false)
	for _, ev := range Events {
		if hooks != nil && hasOurEntry(hooks, ev, shimPath) {
			st.Installed = append(st.Installed, ev)
		} else {
			st.Missing = append(st.Missing, ev)
		}
	}
	return st, nil
}

// Install merges our entries into settings.json (creating the file if absent),
// backing the original up once before the first write. Returns the backup path
// ("" when nothing was written or no original existed).
func Install(settingsPath, shimPath string) (backup string, err error) {
	root, err := readSettings(settingsPath)
	if err != nil {
		return "", err
	}
	hooks := hooksObject(root, true)
	changed := false
	for _, ev := range Events {
		if hasOurEntry(hooks, ev, shimPath) {
			continue
		}
		list, _ := hooks.Get(ev)
		arr, _ := list.([]any)
		arr = append(arr, ourEntry(shimPath))
		hooks.Set(ev, arr)
		changed = true
	}
	if !changed {
		return "", nil
	}
	backup, err = backupOnce(settingsPath)
	if err != nil {
		return "", err
	}
	return backup, writeSettings(settingsPath, root)
}

// Uninstall removes only entries whose command points at our shim, and drops
// empty containers it leaves behind. Other hooks are untouched. Returns whether
// anything was removed.
func Uninstall(settingsPath, shimPath string) (removed bool, err error) {
	root, err := readSettings(settingsPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	hooks := hooksObject(root, false)
	if hooks == nil {
		return false, nil
	}
	for _, key := range append([]string(nil), hooks.Keys...) {
		list, _ := hooks.Get(key)
		arr, ok := list.([]any)
		if !ok {
			continue
		}
		var kept []any
		for _, entry := range arr {
			e, ok := entry.(*Object)
			if !ok || !isOurEntry(e, shimPath) {
				kept = append(kept, entry)
				continue
			}
			removed = true
		}
		if len(kept) == 0 {
			if len(arr) > 0 {
				hooks.Delete(key)
			}
		} else if len(kept) != len(arr) {
			hooks.Set(key, kept)
		}
	}
	if !removed {
		return false, nil
	}
	if hooks.Len() == 0 {
		root.Delete("hooks")
	}
	return true, writeSettings(settingsPath, root)
}

// --- internals ---

func readSettings(path string) (*Object, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return NewObject(), nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if strings.TrimSpace(string(b)) == "" {
		return NewObject(), nil
	}
	v, err := ParseOrdered(b)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w (fix or move the file; Caprock will not overwrite an unparsable settings.json)", path, err)
	}
	obj, ok := v.(*Object)
	if !ok {
		return nil, fmt.Errorf("%s: top level is not a JSON object", path)
	}
	return obj, nil
}

func writeSettings(path string, root *Object) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := MarshalIndent(root)
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(path, b, 0o600)
}

// backupOnce copies settings.json to settings.json.caprock-backup-<unix-ts> if no
// caprock backup exists yet. Returns the backup path or "" when there was no
// original file / a backup already exists.
func backupOnce(path string) (string, error) {
	orig, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	matches, _ := filepath.Glob(path + ".caprock-backup-*")
	if len(matches) > 0 {
		return "", nil
	}
	backup := path + ".caprock-backup-" + strconv.FormatInt(time.Now().Unix(), 10)
	if err := os.WriteFile(backup, orig, 0o600); err != nil {
		return "", fmt.Errorf("write backup: %w", err)
	}
	return backup, nil
}

// hooksObject returns root["hooks"] as an ordered object, creating it when
// create is true. Returns nil when absent and create is false, or when the
// existing value is not an object (we never clobber it).
func hooksObject(root *Object, create bool) *Object {
	v, ok := root.Get("hooks")
	if ok {
		if o, ok := v.(*Object); ok {
			return o
		}
		return nil
	}
	if !create {
		return nil
	}
	o := NewObject()
	root.Set("hooks", o)
	return o
}

func hasOurEntry(hooks *Object, ev, shimPath string) bool {
	list, ok := hooks.Get(ev)
	if !ok {
		return false
	}
	arr, ok := list.([]any)
	if !ok {
		return false
	}
	for _, entry := range arr {
		if e, ok := entry.(*Object); ok && isOurEntry(e, shimPath) {
			return true
		}
	}
	return false
}

// isOurEntry: an entry group whose hooks list contains a command hook pointing at
// our shim (exact path, or any path whose basename is caprock-hook[.exe] — so a
// moved data dir still uninstalls cleanly).
func isOurEntry(e *Object, shimPath string) bool {
	hv, ok := e.Get("hooks")
	if !ok {
		return false
	}
	inner, ok := hv.([]any)
	if !ok {
		return false
	}
	for _, h := range inner {
		ho, ok := h.(*Object)
		if !ok {
			continue
		}
		cmd, _ := ho.Get("command")
		cs, _ := cmd.(string)
		if cs == "" {
			continue
		}
		if cs == shimPath || cs == quoteIfSpaces(shimPath) {
			return true
		}
		base := filepath.Base(strings.Trim(cs, `"`))
		if base == "caprock-hook" || base == "caprock-hook.exe" {
			return true
		}
	}
	return false
}

func ourEntry(shimPath string) *Object {
	h := NewObject()
	h.Set("type", "command")
	h.Set("command", quoteIfSpaces(shimPath))
	h.Set("timeout", ShimTimeoutSeconds)
	e := NewObject()
	e.Set("hooks", []any{h})
	return e
}

// quoteIfSpaces wraps a path containing spaces in double quotes so the shell
// Claude Code uses to run command hooks does not split it (macOS data dir is
// "~/Library/Application Support/caprock/…").
func quoteIfSpaces(p string) string {
	if strings.ContainsAny(p, " \t") && !strings.HasPrefix(p, `"`) {
		return `"` + p + `"`
	}
	return p
}
