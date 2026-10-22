package hooks

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Repaired says what RepairPaths rewrote in one settings.json.
type Repaired struct {
	// Hooks counts our hook commands pointed at the current shim (or
	// removed, where the event already had the current one).
	Hooks int
	// Statusline is whether our statusLine was pointed at this binary.
	Statusline bool
}

// Changed reports whether anything was written.
func (r Repaired) Changed() bool { return r.Hooks > 0 || r.Statusline }

// RepairPaths points Caprock's own entries in settings.json at the binaries
// this install runs, and reports what it changed. shimCmd is what an install
// registers (ShimCommand); statuslineCmd is `<ShellCommand(self)> statusline`,
// or "" to leave the statusLine alone.
//
// An entry is rewritten only when it is ours (the same recognition install
// and uninstall use) and the program it runs is missing or is a different
// file from the one this install would register: a Homebrew caprock that was
// uninstalled, or one months older than the daemon reading its hooks. A
// command of anyone else's is never touched, and neither is ours when it
// already runs this install's binary, whatever its spelling or flags. A
// statusLine's flags (`--width 100`) are kept.
//
// The file is backed up once and written atomically, like every other write
// here. It is the daemon's self-repair at start: nobody can be expected to
// notice that a status line or a hook has been running someone else's binary.
func RepairPaths(settingsPath, shimCmd, statuslineCmd string) (Repaired, error) {
	var r Repaired
	root, err := readSettings(settingsPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return r, nil
		}
		return r, err
	}
	if !exists(settingsPath) {
		return r, nil // no file: nothing of ours to repair, and none to create
	}
	if shimCmd != "" {
		if hooks := hooksObject(root, false); hooks != nil {
			r.Hooks = repairHooks(hooks, shimCmd)
		}
	}
	if statuslineCmd != "" {
		r.Statusline = repairStatuslinePath(root, statuslineCmd)
	}
	if !r.Changed() {
		return r, nil
	}
	if _, err := backupOnce(settingsPath); err != nil {
		return Repaired{}, err
	}
	return r, writeSettings(settingsPath, root)
}

func repairHooks(hooks *Object, shimCmd string) int {
	want := ShellCommand(shimCmd)
	wantProg := commandProgram(want)
	if !exists(wantProg) {
		return 0 // nothing better to point at
	}
	n := 0
	for _, ev := range Events {
		list, ok := hooks.Get(ev)
		if !ok {
			continue
		}
		arr, ok := list.([]any)
		if !ok {
			continue
		}
		// Whether the event already runs the current shim: then a stale entry
		// is removed rather than rewritten, or every event would fire twice.
		current := false
		for _, entry := range arr {
			forEachOurHook(entry, func(cs string) {
				if cs == want || sameProgram(commandProgram(cs), wantProg) {
					current = true
				}
			})
		}
		out := arr[:0:0]
		changed := false
		for _, entry := range arr {
			e, ok := entry.(*Object)
			if !ok {
				out = append(out, entry)
				continue
			}
			hv, _ := e.Get("hooks")
			inner, ok := hv.([]any)
			if !ok {
				out = append(out, entry)
				continue
			}
			kept := inner[:0:0]
			for _, h := range inner {
				ho, ok := h.(*Object)
				cs := ""
				if ok {
					c, _ := ho.Get("command")
					cs, _ = c.(string)
				}
				if !ok || cs == "" || !isOurEntry(single(ho), shimCmd) || cs == want || sameProgram(commandProgram(cs), wantProg) {
					kept = append(kept, h)
					continue
				}
				n++
				changed = true
				if current {
					continue // drop: the event already has the current shim
				}
				ho.Set("command", want)
				current = true
				kept = append(kept, ho)
			}
			if len(kept) == 0 {
				continue
			}
			e.Set("hooks", kept)
			out = append(out, e)
		}
		if changed {
			if len(out) == 0 {
				hooks.Delete(ev)
			} else {
				hooks.Set(ev, out)
			}
		}
	}
	return n
}

// single wraps one hook as an entry group, for isOurEntry.
func single(h *Object) *Object {
	e := NewObject()
	e.Set("hooks", []any{h})
	return e
}

func forEachOurHook(entry any, f func(string)) {
	e, ok := entry.(*Object)
	if !ok {
		return
	}
	hv, _ := e.Get("hooks")
	inner, _ := hv.([]any)
	for _, h := range inner {
		ho, ok := h.(*Object)
		if !ok {
			continue
		}
		c, _ := ho.Get("command")
		cs, _ := c.(string)
		if cs != "" && isOurEntry(single(ho), "") {
			f(cs)
		}
	}
}

func repairStatuslinePath(root *Object, statuslineCmd string) bool {
	v, ok := root.Get("statusLine")
	if !ok {
		return false
	}
	obj, ok := v.(*Object)
	if !ok {
		return false
	}
	c, _ := obj.Get("command")
	cs, _ := c.(string)
	if cs == "" || cs == statuslineCmd || !isOurStatusline(cs, statuslineCmd) {
		return false
	}
	prog, _, ok := splitCommand(cs)
	wantProg, _, wok := splitCommand(statuslineCmd)
	if !ok || !wok || !exists(wantProg) || sameProgram(prog, wantProg) {
		return false
	}
	obj.Set("command", statuslineCmd+statuslineFlags(cs))
	root.Set("statusLine", obj)
	return true
}

// statuslineFlags is what follows the `statusline` word in a command, with
// its leading space, or "".
func statuslineFlags(cs string) string {
	i := strings.LastIndex(cs, "statusline")
	if i < 0 {
		return ""
	}
	rest := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(cs[i+len("statusline"):]), `"`))
	if rest == "" {
		return ""
	}
	return " " + rest
}

// commandProgram is the program a registered hook command runs: the quoted
// path, or the first word, with a trailing ` hook` argument dropped.
func commandProgram(cs string) string {
	cs = strings.TrimSpace(cs)
	if strings.HasPrefix(cs, `"`) {
		if end := strings.IndexByte(cs[1:], '"'); end >= 0 {
			p := cs[1 : 1+end]
			// The quoted-whole-command form an older version wrote.
			return strings.TrimSuffix(p, " hook")
		}
		return strings.Trim(cs, `"`)
	}
	if strings.HasSuffix(cs, " hook") {
		return strings.TrimSuffix(cs, " hook")
	}
	return cs
}

// sameProgram reports whether two command paths run the same file: equal
// once their separators agree, or both present and the same file (a
// Homebrew link and its keg). A missing path is never the same.
func sameProgram(a, b string) bool {
	a, b = filepath.FromSlash(a), filepath.FromSlash(b)
	ai, err := os.Stat(a)
	if err != nil {
		return false
	}
	if a == b {
		return true
	}
	bi, err := os.Stat(b)
	if err != nil {
		return false
	}
	return os.SameFile(ai, bi)
}

func exists(p string) bool {
	_, err := os.Stat(filepath.FromSlash(p))
	return err == nil
}
