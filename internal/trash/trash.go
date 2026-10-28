// Package trash moves a file or folder to the operating system's Trash
// (the Recycle Bin on Windows), never deleting it.
//
// It is the only way the Files tab removes anything (ADR-089): a mistake
// there is undone from the Trash with the system's own Put Back / Restore.
// So every platform moves the item with the system's own trash call or
// with the platform's published trash layout, and where neither can be
// done safely the call is refused with a reason — it never falls back to
// a permanent delete.
//
//   - macOS: NSFileManager's trashItemAtURL, through purego (the binary is
//     built without cgo), which handles other volumes and keeps Put Back.
//   - Windows: SHFileOperationW with FOF_ALLOWUNDO, only on a fixed local
//     drive and only for items small enough that the Recycle Bin keeps
//     them (an item the bin cannot hold would be deleted outright).
//   - Linux and the BSDs: the freedesktop.org Trash specification 1.0 home
//     trash ($XDG_DATA_HOME/Trash, else ~/.local/share/Trash), by rename
//     only, so an item on another file system is refused rather than
//     copied and deleted.
package trash

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// ErrUnavailable is a trash that cannot take this item here; its message
// says why and what to do instead.
var ErrUnavailable = errors.New("the Trash cannot take this item")

// unavailable wraps ErrUnavailable with the reason a person reads.
type unavailable struct{ reason string }

func (u unavailable) Error() string { return u.reason }
func (u unavailable) Unwrap() error { return ErrUnavailable }

// refuse is an ErrUnavailable with its reason.
func refuse(reason string) error { return unavailable{reason} }

// Supported reports whether this platform has a trash Caprock can use, and
// when not, why (shown beside a disabled Delete).
func Supported() (bool, string) { return supported() }

// MaxBytes is the most one call moves to the Recycle Bin on Windows: past
// it the bin may delete instead of keeping (its default size is a share of
// the drive), so the call is refused there. Other platforms do not cap.
const MaxBytes = 1 << 30

// Move puts path — a file, a folder or a symlink (the link itself, never
// its target) — into the Trash. path must be absolute.
func Move(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("trash: path must be absolute")
	}
	if _, err := os.Lstat(path); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fs.ErrNotExist
		}
		return err
	}
	return move(filepath.Clean(path))
}
