//go:build unix

package logcap

import (
	"os"

	"golang.org/x/sys/unix"
)

const supported = true

// pathOf is where stderr's file lives. The daemon only ever logs to one of two
// names in its data dir, so the candidates are checked by identity rather
// than guessed from a descriptor.
func pathOf(fi os.FileInfo) (string, bool) {
	for _, p := range candidates() {
		if st, err := os.Stat(p); err == nil && os.SameFile(fi, st) {
			return p, true
		}
	}
	return "", false
}

// redirect puts f in place of stdout and stderr.
func redirect(f *os.File) error {
	if err := unix.Dup2(int(f.Fd()), int(stdout.Fd())); err != nil {
		return err
	}
	return unix.Dup2(int(f.Fd()), int(stderr.Fd()))
}
