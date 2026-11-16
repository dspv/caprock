package cursor

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/hooks"
)

// The hooks file belongs to the user, and on the owner's machine to another
// tool as well: Orca had registered eight hooks in it before Caprock read it.
// So installing merges — every entry that is not Caprock's is kept as it
// was, keys stay in their order, numbers stay as written — and is
// idempotent; removing takes out Caprock's entries and nothing else. Both
// are the user's own click (POST /v1/cursor/hooks), never automatic.

// HookTimeout is the per-hook timeout written, in seconds. The shim prints
// its reply before it does anything else and gives up on the daemon within
// a second (rule 3); the rest is headroom for a slow disk.
const HookTimeout = 5

// HookCommand is the command registered for every hook: the shim, told it
// is answering Cursor. shim is what hooks.ShimCommand returns — the
// caprock-hook binary, or `<caprock> hook` where there is none.
func HookCommand(shim string) string { return hooks.ShellCommand(shim) + " cursor" }

// HookStatus is what hooks.json holds.
type HookStatus struct {
	Path      string   `json:"path"`
	Installed bool     `json:"installed"`
	Missing   []string `json:"missing,omitempty"`
	// Others is how many entries in the file are somebody else's.
	Others int  `json:"others"`
	Exists bool `json:"exists"`
}

// isOurs reports whether a registered command is Caprock's Cursor hook,
// whatever data directory it was installed from.
func isOurs(cmd string) bool {
	c := strings.TrimSpace(cmd)
	if !strings.HasSuffix(c, " cursor") {
		return false
	}
	c = strings.TrimSpace(strings.TrimSuffix(c, " cursor"))
	c = strings.TrimSuffix(c, " hook")
	c = strings.Trim(c, `"`)
	base := c[strings.LastIndexAny(c, `/\`)+1:]
	switch base {
	case "caprock-hook", "caprock-hook.exe", "caprock", "caprock.exe":
		return true
	}
	return false
}

func readHooks(path string) (*hooks.Object, bool, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return hooks.NewObject(), false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("read %s: %w", path, err)
	}
	if strings.TrimSpace(string(b)) == "" {
		return hooks.NewObject(), true, nil
	}
	v, err := hooks.ParseOrdered(b)
	if err != nil {
		return nil, true, fmt.Errorf("parse %s: %w (Caprock will not rewrite a hooks file it cannot read)", path, err)
	}
	obj, ok := v.(*hooks.Object)
	if !ok {
		return nil, true, fmt.Errorf("%s: top level is not a JSON object", path)
	}
	return obj, true, nil
}

// hookLists is the "hooks" object, created when create is set.
func hookLists(root *hooks.Object, create bool) (*hooks.Object, error) {
	v, ok := root.Get("hooks")
	if !ok {
		if !create {
			return nil, nil
		}
		o := hooks.NewObject()
		root.Set("hooks", o)
		return o, nil
	}
	o, ok := v.(*hooks.Object)
	if !ok {
		return nil, errors.New(`hooks.json: "hooks" is not an object`)
	}
	return o, nil
}

func entryCommand(e any) string {
	o, ok := e.(*hooks.Object)
	if !ok {
		return ""
	}
	v, _ := o.Get("command")
	s, _ := v.(string)
	return s
}

// InspectHooks reports which of HookEvents carry Caprock's hook.
func InspectHooks(path string) (HookStatus, error) {
	st := HookStatus{Path: path}
	root, exists, err := readHooks(path)
	if err != nil {
		return st, err
	}
	st.Exists = exists
	lists, err := hookLists(root, false)
	if err != nil {
		return st, err
	}
	have := map[string]bool{}
	if lists != nil {
		for _, ev := range lists.Keys {
			arr, _ := lists.Values[ev].([]any)
			for _, e := range arr {
				if isOurs(entryCommand(e)) {
					have[ev] = true
				} else {
					st.Others++
				}
			}
		}
	}
	for _, ev := range HookEvents {
		if !have[ev] {
			st.Missing = append(st.Missing, ev)
		}
	}
	st.Installed = len(st.Missing) == 0
	return st, nil
}

// InstallHooks merges Caprock's entries into hooks.json, creating it (with
// `"version": 1`) when there is none. An existing entry of Caprock's is
// replaced in place, so a moved data directory updates rather than doubles.
// The first install backs the file up beside itself.
func InstallHooks(path, shim string) (HookStatus, error) {
	root, exists, err := readHooks(path)
	if err != nil {
		return HookStatus{Path: path}, err
	}
	if exists {
		backupOnce(path)
	}
	if _, ok := root.Get("version"); !ok {
		root.Set("version", 1)
	}
	lists, err := hookLists(root, true)
	if err != nil {
		return HookStatus{Path: path}, err
	}
	cmd := HookCommand(shim)
	for _, ev := range HookEvents {
		var arr []any
		if v, ok := lists.Get(ev); ok {
			a, ok := v.([]any)
			if !ok {
				return HookStatus{Path: path}, fmt.Errorf("hooks.json: %q is not a list", ev)
			}
			arr = a
		}
		out := make([]any, 0, len(arr)+1)
		for _, e := range arr {
			if !isOurs(entryCommand(e)) {
				out = append(out, e)
			}
		}
		h := hooks.NewObject()
		h.Set("command", cmd)
		h.Set("timeout", HookTimeout)
		out = append(out, h)
		lists.Set(ev, out)
	}
	if err := writeHooks(path, root); err != nil {
		return HookStatus{Path: path}, err
	}
	return InspectHooks(path)
}

// UninstallHooks removes Caprock's entries and nothing else. An event list
// that held only Caprock's entry is removed with it.
func UninstallHooks(path string) (HookStatus, error) {
	root, exists, err := readHooks(path)
	if err != nil || !exists {
		st, _ := InspectHooks(path)
		return st, err
	}
	lists, err := hookLists(root, false)
	if err != nil || lists == nil {
		st, _ := InspectHooks(path)
		return st, err
	}
	changed := false
	for _, ev := range append([]string(nil), lists.Keys...) {
		arr, ok := lists.Values[ev].([]any)
		if !ok {
			continue
		}
		out := make([]any, 0, len(arr))
		for _, e := range arr {
			if isOurs(entryCommand(e)) {
				changed = true
				continue
			}
			out = append(out, e)
		}
		if len(out) == len(arr) {
			continue
		}
		if len(out) == 0 {
			lists.Delete(ev)
		} else {
			lists.Set(ev, out)
		}
	}
	if changed {
		if err := writeHooks(path, root); err != nil {
			return HookStatus{Path: path}, err
		}
	}
	return InspectHooks(path)
}

func writeHooks(path string, root *hooks.Object) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	var raw bytes.Buffer
	if err := encode(&raw, root); err != nil {
		return err
	}
	var out bytes.Buffer
	if err := json.Indent(&out, raw.Bytes(), "", "  "); err != nil {
		return err
	}
	out.WriteByte('\n')
	b := out.Bytes()
	mode := os.FileMode(0o644)
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	}
	return config.WriteFileAtomic(path, b, mode)
}

// encode writes an ordered value as JSON without HTML escaping: another
// tool's command such as `cat >/dev/null 2>&1` is written back as it was,
// not as `\u003e/dev/null 2\u003e\u00261`, which means the same and reads
// as damage.
func encode(buf *bytes.Buffer, v any) error {
	switch t := v.(type) {
	case *hooks.Object:
		buf.WriteByte('{')
		for i, k := range t.Keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := encode(buf, k); err != nil {
				return err
			}
			buf.WriteByte(':')
			if err := encode(buf, t.Values[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
		return nil
	case []any:
		buf.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := encode(buf, e); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
		return nil
	default:
		enc := json.NewEncoder(buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(t); err != nil {
			return err
		}
		buf.Truncate(buf.Len() - 1) // Encode's newline
		return nil
	}
}

// backupOnce copies hooks.json to hooks.json.caprock-backup the first time
// Caprock changes it. Best effort: a failed backup does not stop an install
// that only adds entries.
func backupOnce(path string) {
	dst := path + ".caprock-backup"
	if _, err := os.Stat(dst); err == nil {
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	_ = os.WriteFile(dst, b, 0o600)
}
