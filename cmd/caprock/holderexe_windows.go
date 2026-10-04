//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/dspv/caprock/internal/ptyhost"
)

// holderBinary returns a copy of this binary under the data directory, named
// by its content hash, and starts holders from that.
//
// Windows will not replace or delete an executable while a process runs from
// it, and a holder runs for as long as its session does. Started from the
// installed binary, one long session would make the next `scoop update`
// refuse, or fail halfway. Started from a copy, the install directory is free
// and the upgrade proceeds; the old copy is removed by a later start once its
// last holder has exited.
//
// Any failure returns self: a session that pins the install directory is
// better than no session.
func holderBinary(self, dataDir string) string {
	src, err := os.Open(self) //nolint:gosec // our own executable
	if err != nil {
		return self
	}
	defer src.Close()
	h := sha256.New()
	if _, err := io.Copy(h, src); err != nil {
		return self
	}
	sum := hex.EncodeToString(h.Sum(nil))[:16]
	dir := filepath.Join(ptyhost.Dir(dataDir), "bin")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return self
	}
	name := "caprock-" + sum + ".exe"
	dst := filepath.Join(dir, name)
	// Copies of earlier binaries go once nothing runs from them; a running
	// holder's copy cannot be deleted, which is exactly the protection wanted.
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if e.Name() != name && strings.HasPrefix(e.Name(), "caprock-") {
				_ = os.Remove(filepath.Join(dir, e.Name()))
			}
		}
	}
	if fi, err := os.Stat(dst); err == nil && fi.Size() > 0 {
		return dst
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return self
	}
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700) //nolint:gosec // under the data dir
	if err != nil {
		return self
	}
	if _, err := io.Copy(out, src); err != nil {
		_ = out.Close()
		_ = os.Remove(tmp)
		return self
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return self
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return self
	}
	return dst
}
