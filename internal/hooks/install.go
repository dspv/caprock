// Package hooks installs and removes the caprock-hook shim in Claude Code's
// user-level settings.json, non-destructively. See .ai/03-contracts.md § Hook shim.
package hooks

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
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
	if hooks == nil {
		// The "hooks" key exists but is not an object (null, an array, a string
		// — a user who cleared their hooks, or another tool that wrote an empty
		// array). We never clobber it, and we must not dereference it either:
		// this used to reach hasOurEntry as a nil *Object and panic on the very
		// first command a new user runs.
		return "", fmt.Errorf("%s: the \"hooks\" key is %s, not a JSON object (fix or move the file; Caprock will not overwrite an unparsable settings.json)", settingsPath, jsonKindOf(root))
	}
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
	// Whether the user had a settings.json before this write decides both the
	// backup here and any later one in the same run (statusline), so record it
	// before writing rather than re-stat'ing a file we just created.
	_, statErr := os.Stat(settingsPath)
	preexisting := statErr == nil
	backup, err = backupOnce(settingsPath)
	if err != nil {
		return "", err
	}
	if err := writeSettings(settingsPath, root); err != nil {
		return "", err
	}
	if !preexisting {
		markCreatedByUs(settingsPath)
	}
	return backup, nil
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
	// Our hooks are gone, so the "we created this file" marker has served its
	// purpose; leaving it behind would suppress a legitimate backup if the user
	// later edits settings.json and reinstalls.
	_ = os.Remove(createdMarkerPath(settingsPath))
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

// createdMarker sits next to a settings.json that Caprock itself created. Its
// presence means "there was no user file here", so a later backup in the same
// first run would only be snapshotting Caprock's own output.
func createdMarkerPath(path string) string { return path + ".caprock-created" }

// markCreatedByUs records that settings.json did not exist before we wrote it.
// Best-effort: failing to write the marker must not fail an install.
func markCreatedByUs(path string) {
	_ = os.WriteFile(createdMarkerPath(path), []byte("caprock created this settings.json\n"), 0o600)
}

// maxBackups bounds how many settings.json snapshots Caprock keeps. A backup is
// only taken when the file's content differs from every existing one, so this
// caps a pathological case (a user who edits settings.json between every run),
// not ordinary use. The oldest are pruned first; the very first backup — the
// pre-Caprock state, the one most worth having — is always kept.
const maxBackups = 5

// backupOnce copies settings.json to settings.json.caprock-backup-<unix-ts>
// when the current content is not already captured by an existing backup.
// Returns the backup path, or "" when there was no original file or its content
// is already backed up.
//
// It used to return early if *any* backup existed, which made the snapshot
// permanently stale: on the owner's machine the only backup was dated 10 July
// while settings.json had been modified 20 August, so the file it would restore
// no longer resembled the one it was protecting. Content-comparing instead of
// existence-checking keeps the "don't snapshot our own output twice in one run"
// property — the content is unchanged within a run — while still refreshing
// after the user edits their settings.
func backupOnce(path string) (string, error) {
	orig, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	// The file exists — but if we are the ones who created it moments ago, a
	// "backup" would capture Caprock's own hooks and be misnamed as a restore
	// point. `caprock up` on a machine with no settings.json ran Install (which
	// creates the file) and then maybeInstallStatusline, whose backupOnce
	// snapshotted the now-hook-laden file.
	if _, err := os.Stat(createdMarkerPath(path)); err == nil {
		return "", nil
	}
	matches, _ := filepath.Glob(path + ".caprock-backup-*")
	for _, m := range matches {
		if b, err := os.ReadFile(m); err == nil && bytes.Equal(b, orig) {
			return "", nil // this exact content is already preserved
		}
	}
	backup := freeBackupName(path)
	if err := os.WriteFile(backup, orig, 0o600); err != nil {
		return "", fmt.Errorf("write backup: %w", err)
	}
	pruneBackups(path)
	return backup, nil
}

// freeBackupName returns a backup path that does not exist yet. The timestamp
// has one-second resolution, so two backups inside the same second would
// otherwise collide and the second would silently overwrite the first —
// destroying a snapshot while reporting success. A "-2", "-3"… suffix
// disambiguates; the timestamp still sorts first.
func freeBackupName(path string) string {
	base := path + ".caprock-backup-" + strconv.FormatInt(time.Now().Unix(), 10)
	if _, err := os.Stat(base); os.IsNotExist(err) {
		return base
	}
	for i := 2; i < 1000; i++ {
		cand := base + "-" + strconv.Itoa(i)
		if _, err := os.Stat(cand); os.IsNotExist(err) {
			return cand
		}
	}
	return base
}

// pruneBackups keeps the oldest backup (the closest thing to a pre-Caprock
// state) plus the most recent maxBackups-1, deleting the rest. Best-effort:
// failing to prune leaves extra files, which is harmless.
func pruneBackups(path string) {
	matches, _ := filepath.Glob(path + ".caprock-backup-*")
	if len(matches) <= maxBackups {
		return
	}
	// The timestamp suffix is fixed-width for any plausible date, so a lexical
	// sort is chronological; sort explicitly by parsed ts to be safe.
	sort.Slice(matches, func(i, j int) bool { return backupTs(matches[i]) < backupTs(matches[j]) })
	// Keep matches[0] (oldest) and the last maxBackups-1.
	for _, m := range matches[1 : len(matches)-(maxBackups-1)] {
		_ = os.Remove(m)
	}
}

// backupTs extracts the unix timestamp from a backup filename, or 0. It
// tolerates the "-2", "-3"… collision suffix freeBackupName may append.
func backupTs(name string) int64 {
	i := strings.LastIndex(name, ".caprock-backup-")
	if i < 0 {
		return 0
	}
	suffix := name[i+len(".caprock-backup-"):]
	if dash := strings.IndexByte(suffix, '-'); dash >= 0 {
		suffix = suffix[:dash]
	}
	ts, _ := strconv.ParseInt(suffix, 10, 64)
	return ts
}

// ListBackups returns the Caprock backups of settings.json, oldest first.
func ListBackups(settingsPath string) []string {
	matches, _ := filepath.Glob(settingsPath + ".caprock-backup-*")
	sort.Slice(matches, func(i, j int) bool { return backupTs(matches[i]) < backupTs(matches[j]) })
	return matches
}

// Restore copies a backup back over settings.json. It takes the backup path
// explicitly rather than picking one, because choosing which snapshot a user
// wants is a decision only they can make. Before overwriting it snapshots the
// current file, so a restore is itself undoable.
func Restore(settingsPath, backupPath string) error {
	b, err := os.ReadFile(backupPath)
	if err != nil {
		return err
	}
	if _, err := ParseOrdered(b); err != nil {
		return fmt.Errorf("refusing to restore unparsable backup %s: %w", backupPath, err)
	}
	if _, err := backupOnce(settingsPath); err != nil {
		return err
	}
	return config.WriteFileAtomic(settingsPath, b, 0o600)
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

// jsonKindOf names the JSON type of root["hooks"] for an error message. A user
// whose settings.json holds `{"hooks": []}` needs to be told which key is wrong
// and what it currently is, not handed a type assertion failure.
func jsonKindOf(root *Object) string {
	v, ok := root.Get("hooks")
	if !ok {
		return "absent"
	}
	switch v.(type) {
	case nil:
		return "null"
	case []any:
		return "an array"
	case string:
		return "a string"
	case bool:
		return "a boolean"
	// ParseOrdered decodes with UseNumber to keep big integers intact, so a
	// numeric value arrives as json.Number rather than float64.
	case json.Number, float64:
		return "a number"
	}
	return "not an object"
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
		// Three accepted forms, because an existing install must keep being
		// recognised: bare (what versions before the always-quote fix wrote on
		// a path without spaces), and quoted (what every install writes now).
		if cs == shimPath || cs == quoteForShell(shimPath) {
			return true
		}
		// Recognize our entry regardless of which command form was installed: the
		// dedicated shim (`…/caprock-hook`) or the fallback self-hook
		// (`…/caprock hook`). The daemon inspects with the data-dir shim path, but
		// a formula/`go install` layout with no sibling shim registers the
		// self-hook form — both are ours, so status must not read 0/N for a
		// working install.
		trimmed := strings.Trim(cs, `"`)
		base := filepath.Base(trimmed)
		if base == "caprock-hook" || base == "caprock-hook.exe" {
			return true
		}
		if fields := strings.Fields(trimmed); len(fields) == 2 && fields[1] == "hook" {
			if b := filepath.Base(fields[0]); b == "caprock" || b == "caprock.exe" {
				return true
			}
		}
	}
	return false
}

func ourEntry(shimPath string) *Object {
	h := NewObject()
	h.Set("type", "command")
	h.Set("command", quoteForShell(shimPath))
	h.Set("timeout", ShimTimeoutSeconds)
	e := NewObject()
	e.Set("hooks", []any{h})
	return e
}

// quoteForShell wraps the shim path in double quotes so the shell Claude Code
// runs command hooks through neither splits it nor eats it.
//
// Spaces were the original reason (the macOS data dir is "~/Library/Application
// Support/caprock/…"), but a Windows path needs quoting even without one: the
// shell is bash, and bare `C:\Users\las\AppData\Roaming\caprock\caprock-hook.exe`
// arrives as `C:UserslasAppDataRoamingcaprockcaprock-hook.exe` because every
// backslash is read as an escape. Reported from a real install — hooks never
// fired, and the only evidence was one "command not found" in a Stop hook.
//
// So: always quote. A quoted path is correct on every platform, and the cost
// is two characters.
func quoteForShell(p string) string {
	if strings.HasPrefix(p, `"`) {
		return p
	}
	// The fallback registration is `<exe> hook` — a path *and* an argument.
	// Quoting the whole string would send bash looking for a binary literally
	// named "…caprock.exe hook", so only the path half is quoted.
	if strings.HasSuffix(p, " hook") {
		return `"` + strings.TrimSuffix(p, " hook") + `" hook`
	}
	return `"` + p + `"`
}
