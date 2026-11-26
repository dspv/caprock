//go:build !windows

package main

import "github.com/dspv/caprock/internal/ptyhost"

// holderBinary is the running binary itself. A package manager replacing it
// on upgrade does not disturb a holder already running from it: the old file
// stays open until the holder exits.
//
// The Caprock Terminal helper on macOS is the exception: holders start from
// a copy of its bundle under the data directory (ptyhost.StageHelper),
// because macOS stops trusting a holder whose bundle an update replaced and
// silently refuses it the microphone (ADR-101).
func holderBinary(self, dataDir string) string { return ptyhost.StageHelper(self, dataDir) }
