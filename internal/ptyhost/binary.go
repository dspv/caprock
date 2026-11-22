package ptyhost

import (
	"os"
	"path/filepath"
	"runtime"
)

// Arg is the argument that makes a process a holder: `caprock pty-host`, or
// `caprock-pty-host pty-host` for the holder-only binary. The daemon's sweep
// for holders recognises one by it.
const Arg = "pty-host"

// BinaryName is the file name of the holder-only binary (cmd/caprock-pty-host),
// which releases ship beside caprock.
func BinaryName() string {
	if runtime.GOOS == "windows" {
		return "caprock-pty-host.exe"
	}
	return "caprock-pty-host"
}

// Binary returns the binary a daemon running from self starts holders from:
// the holder-only binary when one sits beside self, or beside the file self
// links to, and self otherwise.
//
// Either one runs the same holder. The holder-only binary links nothing else,
// so a terminal costs less memory in it: the caprock binary pays for the whole
// daemon's package initialisation in every process it starts (ADR-033).
// Without it — `go build ./cmd/caprock`, `go install` — sessions run in
// `caprock pty-host` as they always have.
//
// On macOS the Caprock Terminal helper beside self comes first (ADR-101):
// the same holder-only binary inside a signed bundle of its own.
func Binary(self string) string {
	dirs := []string{filepath.Dir(self)}
	if r, err := filepath.EvalSymlinks(self); err == nil && filepath.Dir(r) != dirs[0] {
		dirs = append(dirs, filepath.Dir(r))
	}
	for _, d := range dirs {
		if runtime.GOOS == "darwin" {
			if p := HelperExe(d); executable(p) {
				return p
			}
		}
		p := filepath.Join(d, BinaryName())
		if executable(p) {
			return p
		}
	}
	return self
}

// executable reports whether p is a regular file this process could run.
func executable(p string) bool {
	fi, err := os.Stat(p)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() == 0 {
		return false
	}
	return runtime.GOOS == "windows" || fi.Mode().Perm()&0o111 != 0
}
