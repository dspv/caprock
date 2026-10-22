package hooks

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"

	"github.com/dspv/caprock/internal/config"
)

// EnsureShim brings `<data dir>/caprock-hook` up to date with this binary,
// the path every settings.json Caprock wrote runs on each hook event.
//
//   - A caprock-hook beside this executable (Homebrew, the release archives,
//     `make build`) is copied in whenever the bytes differ.
//   - With none beside it (the desktop app ships caprock alone), an existing
//     data-dir shim is replaced by this binary itself, which runs as the shim
//     when started under that name (cmd/caprock). Without this, a shim a
//     Homebrew install put there months earlier kept feeding hooks to every
//     later daemon, because nothing ever replaced it (a user's 0.31.2 shim
//     under 0.147.0). With no data-dir shim either, nothing is written and
//     `<self> hook` is the registered command (ShimCommand).
//
// Every write goes to a temporary file in the data dir and is renamed over the
// shim, so Claude Code, which may run it at any moment, sees the old file or
// the new one and never a missing or half-written one (rule 3).
func EnsureShim(dataDir string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	return ensureShimFrom(self, dataDir)
}

func ensureShimFrom(self, dataDir string) error {
	dst := config.ShimPath(dataDir)
	src := filepath.Join(filepath.Dir(self), filepath.Base(dst))
	if _, err := os.Stat(src); err == nil {
		return refreshShim(src, dst)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// No sibling shim. Only the caprock binary can stand in for one: a test
	// binary or a renamed preview build would not answer to the shim's name.
	if b := strings.TrimSuffix(filepath.Base(self), ".exe"); b != "caprock" {
		return nil
	}
	if _, err := os.Stat(dst); errors.Is(err, os.ErrNotExist) {
		return nil // nothing stale to replace; ShimCommand registers `<self> hook`
	} else if err != nil {
		return err
	}
	return refreshShim(self, dst)
}

// refreshShim makes dst the same file as src, atomically, when it is not
// already: the same file, or the same size and bytes, means nothing to do.
func refreshShim(src, dst string) error {
	si, err := os.Stat(src)
	if err != nil {
		return err
	}
	if di, err := os.Stat(dst); err == nil {
		if os.SameFile(si, di) {
			return nil
		}
		if di.Size() == si.Size() && sameBytes(src, dst) {
			return nil
		}
	}
	if err := replaceFile(src, dst); err != nil {
		return fmt.Errorf("install shim into data dir: %w", err)
	}
	return nil
}

func sameBytes(a, b string) bool {
	fa, err := os.Open(a)
	if err != nil {
		return false
	}
	defer fa.Close()
	fb, err := os.Open(b)
	if err != nil {
		return false
	}
	defer fb.Close()
	ba, bb := make([]byte, 64<<10), make([]byte, 64<<10)
	for {
		na, ea := io.ReadFull(fa, ba)
		nb, eb := io.ReadFull(fb, bb)
		if na != nb || !bytes.Equal(ba[:na], bb[:nb]) {
			return false
		}
		if ea != nil || eb != nil {
			return (ea == io.EOF || ea == io.ErrUnexpectedEOF) && (eb == io.EOF || eb == io.ErrUnexpectedEOF)
		}
	}
}

// replaceFile puts a copy of src at dst through a temporary file beside dst,
// made executable, then renamed over dst. A copy, never a hard link: anything
// that later wrote the shim in place would be writing the daemon binary. On
// Windows a shim that is running cannot be replaced; the rename fails, the
// temporary file is removed and the old shim stays where it was, to be
// replaced on the next start.
var tmpSeq atomic.Uint64

func replaceFile(src, dst string) error {
	dir := filepath.Dir(dst)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	// Unique per call: the daemon's start and a subscription's may refresh
	// the shim at the same moment.
	tmp := filepath.Join(dir, fmt.Sprintf(".%s.%d.%d.tmp", filepath.Base(dst), os.Getpid(), tmpSeq.Add(1)))
	_ = os.Remove(tmp)
	if err := copyFile(src, tmp); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Chmod(0o755); err != nil && runtime.GOOS != "windows" {
		_ = out.Close()
		return err
	}
	return out.Close()
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
	st, err := StatusFor(dataDir, settingsPath)
	return st, backup, err
}

// StatusFor is what is registered, checked against the command an install
// would write — the one question /v1/status, `caprock status` and the
// Install button must all answer the same way.
//
// The daemon used to check against the data-dir shim path alone. When no
// caprock-hook sat beside the executable, install registered the fallback
// `"<exe>" hook`, which the check recognised only if the executable was named
// caprock; under any other name (a renamed or preview build) the button said
// "installed" and the next status said all nine events were missing.
func StatusFor(dataDir, settingsPath string) (Status, error) {
	return Inspect(settingsPath, ShimCommand(dataDir))
}
