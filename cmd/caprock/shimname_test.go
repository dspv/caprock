package main

import "testing"

// The desktop app puts caprock itself at <data dir>/caprock-hook, and it must
// run as the shim there, whichever separator the path arrives with.
func TestIsShimName(t *testing.T) {
	for arg0, want := range map[string]bool{
		"/Users/a/Library/Application Support/caprock/caprock-hook": true,
		`C:\Users\a\AppData\Roaming\caprock\caprock-hook.exe`:       true,
		"caprock-hook":                true,
		"/usr/local/bin/caprock":      false,
		"caprock.exe":                 false,
		"/tmp/caprock-hook-x/caprock": false,
	} {
		if got := isShimName(arg0); got != want {
			t.Errorf("isShimName(%q) = %v, want %v", arg0, got, want)
		}
	}
}
