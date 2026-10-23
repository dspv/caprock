package hooks

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/dspv/caprock/internal/config"
)

// RetentionKey is the user setting that says how many days Claude Code keeps
// a conversation's transcript under ~/.claude/projects. At startup it deletes
// every transcript older than that; unset, the period is
// DefaultRetentionDays. Caprock can only import what is still on disk, so a
// new user's history starts about that many days back.
const RetentionKey = "cleanupPeriodDays"

// DefaultRetentionDays is Claude Code's period when the key is unset.
const DefaultRetentionDays = 30

// KeepRetentionDays is what "Keep them from now on" writes: a hundred years,
// which is Claude Code never deleting a transcript by age.
const KeepRetentionDays = 36500

// Retention is what the user settings say about it.
type Retention struct {
	// Days is the period Claude Code applies: the setting, or
	// DefaultRetentionDays when it is unset.
	Days int `json:"days"`
	// Set reports whether the settings name a period at all.
	Set bool `json:"set"`
}

// ReadRetention reads cleanupPeriodDays from user settings. A missing file
// is the default period, not an error; an unparsable one is an error, the
// same as for every other read of this file. A value that is not a number
// is taken as unset, which is how Claude Code's settings check treats it.
func ReadRetention(settingsPath string) (Retention, error) {
	root, err := readSettings(settingsPath)
	if err != nil {
		return Retention{}, err
	}
	if n, ok := retentionOf(root); ok {
		return Retention{Days: n, Set: true}, nil
	}
	return Retention{Days: DefaultRetentionDays}, nil
}

func retentionOf(root *Object) (int, bool) {
	v, ok := root.Get(RetentionKey)
	if !ok {
		return 0, false
	}
	num, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	n, err := num.Int64()
	if err != nil {
		f, ferr := num.Float64()
		if ferr != nil {
			return 0, false
		}
		n = int64(f)
	}
	return int(n), true
}

// KeepTranscripts writes cleanupPeriodDays = days into user settings, the
// one key changed and every other byte of the file left as it was: the
// value is replaced where it stands, or the key is added first in the
// object, indented like the key after it. The user asked for it on the
// Lifetime screen, after it said what the setting does.
//
// The file is backed up once first, as for the hooks entry, and written
// atomically. An unparsable file is refused, never overwritten: Claude Code
// would refuse it too, and the user's own edits are in it. Asking again for
// the period already set changes nothing and writes nothing.
func KeepTranscripts(settingsPath string, days int) (changed bool, err error) {
	if days <= 0 {
		return false, fmt.Errorf("a retention period is a positive number of days, not %d", days)
	}
	orig, err := os.ReadFile(settingsPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("read %s: %w", settingsPath, err)
	}
	root, err := readSettings(settingsPath)
	if err != nil {
		return false, err
	}
	if n, ok := retentionOf(root); ok && n == days {
		return false, nil
	}
	out, err := withRetention(orig, root, days)
	if err != nil {
		return false, err
	}
	// The edit is checked the way it will be read: one object, the one key
	// changed.
	v, err := ParseOrdered(out)
	if err != nil {
		return false, fmt.Errorf("settings edit would not parse (nothing written): %w", err)
	}
	if obj, ok := v.(*Object); !ok || obj.Len() != root.Len()+boolInt(!has(root, RetentionKey)) {
		return false, errors.New("settings edit changed more than one key (nothing written)")
	} else if n, ok := retentionOf(obj); !ok || n != days {
		return false, errors.New("settings edit did not set the period (nothing written)")
	}
	if _, err := backupOnce(settingsPath); err != nil {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o700); err != nil {
		return false, err
	}
	perm := os.FileMode(0o600)
	if st, err := os.Stat(settingsPath); err == nil {
		perm = st.Mode().Perm()
	}
	return true, config.WriteFileAtomic(settingsPath, out, perm)
}

func has(o *Object, k string) bool { _, ok := o.Get(k); return ok }

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// withRetention is the file's bytes with the key set to days. root is the
// same bytes parsed, already known to be an object.
func withRetention(orig []byte, root *Object, days int) ([]byte, error) {
	val := strconv.Itoa(days)
	if root.Len() == 0 {
		// Nothing to keep but whitespace: the file Claude Code would write.
		return []byte("{\n  \"" + RetentionKey + "\": " + val + "\n}\n"), nil
	}
	open, start, end, found, err := topLevelValue(orig, RetentionKey)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	if found {
		out.Write(orig[:start])
		out.WriteString(val)
		out.Write(orig[end:])
		return out.Bytes(), nil
	}
	// First in the object, with the whitespace that precedes the key after
	// it: "{\n  " stays "{\n  ", compact stays compact.
	ws := orig[open : open+leadingSpace(orig[open:])]
	sep := ": "
	if len(ws) == 0 {
		sep = ":"
	}
	out.Write(orig[:open])
	out.Write(ws)
	out.WriteString(`"` + RetentionKey + `"` + sep + val + ",")
	out.Write(orig[open:])
	return out.Bytes(), nil
}

func leadingSpace(b []byte) int {
	n := 0
	for n < len(b) && (b[n] == ' ' || b[n] == '\t' || b[n] == '\n' || b[n] == '\r') {
		n++
	}
	return n
}

// topLevelValue finds key in the top-level object of b: open is the offset
// just past its '{', and [start, end) the last occurrence's value (the one a
// JSON reader keeps).
func topLevelValue(b []byte, key string) (open, start, end int, found bool, err error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil {
		return 0, 0, 0, false, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return 0, 0, 0, false, errors.New("top level is not a JSON object")
	}
	open = int(dec.InputOffset())
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return 0, 0, 0, false, err
		}
		k, _ := kt.(string)
		after := int(dec.InputOffset())
		if _, err := parseValue(dec); err != nil {
			return 0, 0, 0, false, err
		}
		if k != key {
			continue
		}
		s := after
		for s < len(b) && (b[s] == ':' || leadingSpace(b[s:s+1]) == 1) {
			s++
		}
		start, end, found = s, int(dec.InputOffset()), true
	}
	return open, start, end, found, nil
}
