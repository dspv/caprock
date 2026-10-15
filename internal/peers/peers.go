// Package peers keeps the other computers this machine reaches, and the
// channel to each (ADR-067).
//
// Each computer is a Caprock daemon with access from anywhere on (ADR-058).
// This machine pairs with it the way a phone does — the target's owner shows
// a code there, this machine redeems it through the relay — and keeps the
// device token it is given in machines.json, mode 0600, beside remote.json and
// devices.json. From then on every request this machine makes for that
// computer goes through one end-to-end encrypted channel (remote.Client) and
// arrives there as that paired device, with the role its owner gave it.
//
// The direction matters. Pairing gives this machine access to the target and
// nothing back: the target lists this machine among its devices and can
// revoke it at any time, and access is not transitive — a phone paired with
// this machine never reaches the target through it.
//
// Nothing here starts, signals or types into a process (rule 7). It carries
// requests to the target's daemon, and the target decides, with its own
// gate, what a device in this role may do there.
package peers

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/dspv/caprock/internal/config"
)

// File holds the computers this machine reaches: their relay, id, pinned key
// and this machine's device token on each. Bearer tokens, so its own file at
// 0600 — never config.json, which is edited by hand and pasted into support
// threads.
const File = "machines.json"

// Machine is one computer this machine has paired with.
type Machine struct {
	// ID is the computer's relay id: its Ed25519 public key, base64url. Also
	// how the rest of Caprock names it.
	ID string `json:"id"`
	// Key is its X25519 static key, base64url, which every handshake pins.
	Key string `json:"key"`
	// Relay is where it waits, from its pairing link.
	Relay string `json:"relay"`
	// Name is what the user calls it; from the link, renamable here.
	Name string `json:"name"`
	// Token is this machine's device token on it. Never listed, never sent
	// anywhere but inside the channel to that computer.
	Token string `json:"token"`
	// DeviceID is how the computer lists this machine among its devices.
	DeviceID string `json:"device_id"`
	// AddedAt is unix milliseconds, this machine's clock.
	AddedAt int64 `json:"added_at"`
}

// Read loads the list. A missing file is no computers; a corrupt one is an
// error the caller logs and treats as none — the safe reading of "I cannot
// tell which computers I may reach" costs a re-pair and risks nothing.
func Read(dir string) ([]Machine, error) {
	b, err := os.ReadFile(filepath.Join(dir, File))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ms []Machine
	if err := json.Unmarshal(b, &ms); err != nil {
		return nil, err
	}
	out := ms[:0]
	for _, m := range ms {
		if m.ID != "" && m.Key != "" && m.Relay != "" && m.Token != "" {
			out = append(out, m)
		}
	}
	return out, nil
}

// Write saves the list, 0600, atomically. On Windows the mode is not
// enforced; the file lives in the user's own profile, as devices.json does.
func Write(dir string, ms []Machine) error {
	if ms == nil {
		ms = []Machine{}
	}
	b, err := json.MarshalIndent(ms, "", "  ")
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(filepath.Join(dir, File), b, 0o600)
}

// cleanName keeps a computer's label short and printable. It comes from a
// pairing link or a request body: shown, never interpreted.
func cleanName(s string) string {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s))
	if r := []rune(s); len(r) > 40 {
		s = string(r[:40])
	}
	return s
}
