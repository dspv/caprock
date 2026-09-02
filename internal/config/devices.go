package config

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/dspv/caprock/internal/pairing"
)

// devicesFile holds the tablets and phones that have been let in.
//
// Kept out of config.json deliberately. That file is edited by hand and shown
// in support threads; this one holds bearer tokens, and a file whose whole
// content is a set of keys should be readable at a glance as exactly that.
// Mode 0600, like the licence key and the report bot token.
const devicesFile = "devices.json"

// WriteDevices saves the paired devices. Called after every pairing and every
// revocation, so a restart does not send someone walking back to their tablet.
//
// What does *not* survive a restart is the decision to listen on the network
// at all: that is a run flag, so a laptop opened in a coworking space cannot
// carry a choice made at home. Devices are the guest list; the listener is the
// open door.
func WriteDevices(dir string, ds []pairing.Device) error {
	b, err := json.MarshalIndent(ds, "", "  ")
	if err != nil {
		return err
	}
	return WriteFileAtomic(filepath.Join(dir, devicesFile), b, 0o600)
}

// ReadDevices restores the guest list. A missing file is the normal first-run
// case and returns nothing rather than an error.
func ReadDevices(dir string) ([]pairing.Device, error) {
	b, err := os.ReadFile(filepath.Join(dir, devicesFile))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ds []pairing.Device
	if err := json.Unmarshal(b, &ds); err != nil {
		// A corrupt guest list must not stop the daemon: the safe reading of
		// "I cannot tell who was allowed in" is "nobody is", which costs a
		// re-pair and risks nothing.
		return nil, err
	}
	return ds, nil
}

// RemoveDevices forgets every paired device.
func RemoveDevices(dir string) error {
	err := os.Remove(filepath.Join(dir, devicesFile))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}
