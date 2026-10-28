//go:build !darwin && !windows

package trash

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// The freedesktop.org Trash specification, home trash only: the item is
// renamed into $XDG_DATA_HOME/Trash/files under a free name, after an
// info file naming where it was and when is created with O_EXCL (the
// spec's order, so a crash leaves an orphan info file, never an orphan
// item). A rename across file systems fails with EXDEV and is refused: the
// spec's per-volume $topdir/.Trash-$uid would be the place, and v1 leaves
// such items to the desktop's file manager.

func homeTrash() (string, error) {
	if d := os.Getenv("XDG_DATA_HOME"); d != "" && filepath.IsAbs(d) {
		return filepath.Join(d, "Trash"), nil
	}
	h, err := os.UserHomeDir()
	if err != nil || h == "" {
		return "", refuse("no home folder, so there is no Trash")
	}
	return filepath.Join(h, ".local", "share", "Trash"), nil
}

func supported() (bool, string) {
	if _, err := homeTrash(); err != nil {
		return false, err.Error()
	}
	return true, ""
}

func move(path string) error {
	dir, err := homeTrash()
	if err != nil {
		return err
	}
	files, info := filepath.Join(dir, "files"), filepath.Join(dir, "info")
	for _, d := range []string{files, info} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return refuse("the Trash folder could not be made: " + err.Error())
		}
	}
	base := filepath.Base(path)
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	body := fmt.Sprintf("[Trash Info]\nPath=%s\nDeletionDate=%s\n", escapePath(path), time.Now().Format("2006-01-02T15:04:05"))
	for i := 0; i < 1000; i++ {
		name := base
		if i > 0 {
			name = fmt.Sprintf("%s.%d%s", stem, i, ext)
		}
		ip := filepath.Join(info, name+".trashinfo")
		f, err := os.OpenFile(ip, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return refuse("the Trash's info file could not be written: " + err.Error())
		}
		_, werr := f.WriteString(body)
		cerr := f.Close()
		if werr != nil || cerr != nil {
			_ = os.Remove(ip)
			return refuse("the Trash's info file could not be written")
		}
		dst := filepath.Join(files, name)
		if _, err := os.Lstat(dst); err == nil {
			_ = os.Remove(ip)
			continue
		}
		if err := os.Rename(path, dst); err != nil {
			_ = os.Remove(ip)
			if errors.Is(err, syscall.EXDEV) {
				return refuse("it is on another drive than your home folder's Trash; delete it in your file manager")
			}
			return refuse("it could not be moved to the Trash: " + err.Error())
		}
		return nil
	}
	return refuse("the Trash has too many items of that name")
}

// escapePath is the spec's Path= value: an absolute path, URL-escaped by
// segment (RFC 2396), slashes kept.
func escapePath(p string) string {
	parts := strings.Split(p, "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}
