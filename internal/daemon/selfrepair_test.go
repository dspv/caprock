package daemon

import "testing"

// Only a released build repairs settings.json: a development daemon on a
// developer's machine would otherwise point real hooks at a worktree.
func TestOnlyAReleaseRepairsHookPaths(t *testing.T) {
	for v, want := range map[string]bool{
		"0.147.0":                    true,
		"v0.147.0":                   true,
		"dev":                        false,
		"v0.147.0-1-g787035ac-dirty": false,
		"v0.147.0-1-g787035ac":       false,
		"0.148.0-rc.1":               false,
		"":                           false,
	} {
		if got := isRelease(v); got != want {
			t.Errorf("isRelease(%q) = %v, want %v", v, got, want)
		}
	}
}
