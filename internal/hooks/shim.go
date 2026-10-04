package hooks

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dspv/caprock/internal/config"
)

// EnsureShim copies caprock-hook from beside this executable into the data dir
// (if present and different). When no sibling shim exists, `caprock hook` is
// used as the fallback command (ShimCommand).
func EnsureShim(dataDir string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	src := filepath.Join(filepath.Dir(self), filepath.Base(config.ShimPath(dataDir)))
	dst := config.ShimPath(dataDir)
	sb, err := os.ReadFile(src)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil // fallback handled by ShimCommand
		}
		return err
	}
	if db, err := os.ReadFile(dst); err == nil && string(db) == string(sb) {
		return nil
	}
	if err := config.WriteFileAtomic(dst, sb, 0o755); err != nil {
		return fmt.Errorf("install shim into data dir: %w", err)
	}
	return nil
}

// ShimCommand returns the command to register in settings.json: the shim
// binary in the data dir when it exists, else `<self> hook`.
func ShimCommand(dataDir string) string {
	if _, err := os.Stat(config.ShimPath(dataDir)); err == nil {
		return config.ShimPath(dataDir)
	}
	self, err := os.Executable()
	if err != nil {
		return config.ShimPath(dataDir)
	}
	return self + " hook"
}

// InstallFor is `caprock hooks install` as one call, for the CLI and the
// dashboard's Install button alike: put the shim in the data dir, merge our
// entries into the settings file at settingsPath (backed up first), and report
// what is registered now. The two used to be separate code in cmd/caprock;
// one path means the button cannot install something the command would not.
func InstallFor(dataDir, settingsPath string) (Status, string, error) {
	if err := EnsureShim(dataDir); err != nil {
		return Status{}, "", err
	}
	cmd := ShimCommand(dataDir)
	backup, err := Install(settingsPath, cmd)
	if err != nil {
		return Status{}, "", err
	}
	st, err := Inspect(settingsPath, cmd)
	return st, backup, err
}
