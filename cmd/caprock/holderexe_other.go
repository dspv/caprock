//go:build !windows

package main

// holderBinary is the running binary itself. A package manager replacing it
// on upgrade does not disturb a holder already running from it: the old file
// stays open until the holder exits.
func holderBinary(self, _ string) string { return self }
