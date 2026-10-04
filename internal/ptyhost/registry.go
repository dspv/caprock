package ptyhost

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Record is a running holder's registry entry, <data>/ptyhost/<session>.json.
// It is how a daemon that did not start the holder finds it: where it listens,
// the token it wants, and enough about the session to show it.
//
// The file is the holder's to write and remove. The daemon only deletes one
// whose holder is gone (nothing listens at Addr any more).
type Record struct {
	Proto     int       `json:"proto"`
	SessionID string    `json:"session_id"`
	HostPID   int       `json:"host_pid"`
	ChildPID  int       `json:"child_pid"`
	Addr      string    `json:"addr"`
	Token     string    `json:"token"`
	Cwd       string    `json:"cwd"`
	Command   string    `json:"command"`
	StartedAt time.Time `json:"started_at"`
	// Version is the Caprock release that started the holder, for the log
	// line a mismatch is diagnosed from. Compatibility is Proto's job.
	Version string `json:"version,omitempty"`
	// Meta is the spawn's ptyman.Spec.Meta, kept for the daemon that
	// reattaches: which agent it is, and anything the daemon needs to keep
	// watching it.
	Meta map[string]string `json:"meta,omitempty"`
}

// ExitRecord is left behind when a session ends while no daemon is connected,
// so the next one can record how it ended rather than only that it did.
type ExitRecord struct {
	SessionID string    `json:"session_id"`
	Code      int       `json:"code"`
	At        time.Time `json:"at"`
}

// Dir is where holders register, under the data directory.
func Dir(dataDir string) string { return filepath.Join(dataDir, "ptyhost") }

func recordPath(dir, id string) string { return filepath.Join(dir, id+".json") }
func exitPath(dir, id string) string   { return filepath.Join(dir, id+".exit") }

// validID reports whether a session id is safe to use as a file name. Ids are
// UUIDs, but a resumed session's id arrives in a request body, and a registry
// path built from one must not be able to point anywhere else.
func validID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// writeJSONAtomic writes v to path through a temporary file and a rename, so
// a reader never sees half a record.
func writeJSONAtomic(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// readRecords lists the registry. Unreadable or foreign files are skipped, not
// fatal: one corrupt entry must not stop every other session reattaching.
func readRecords(dir string) ([]Record, []ExitRecord, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	var recs []Record
	var exits []ExitRecord
	for _, e := range entries {
		name := e.Name()
		switch {
		case strings.HasSuffix(name, ".json"):
			var r Record
			b, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil || json.Unmarshal(b, &r) != nil || !validID(r.SessionID) || r.SessionID+".json" != name {
				continue
			}
			recs = append(recs, r)
		case strings.HasSuffix(name, ".exit"):
			var x ExitRecord
			b, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil || json.Unmarshal(b, &x) != nil || !validID(x.SessionID) || x.SessionID+".exit" != name {
				continue
			}
			exits = append(exits, x)
		}
	}
	return recs, exits, nil
}
