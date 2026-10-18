package daemon

import (
	"path/filepath"
	"testing"
)

func TestStablePathSurvivesABrewUpgrade(t *testing.T) {
	for in, want := range map[string]string{
		"/opt/homebrew/Cellar/caprock/0.134.0/bin/caprock":            "/opt/homebrew/bin/caprock",
		"/home/linuxbrew/.linuxbrew/Cellar/caprock/1.2.3/bin/caprock": "/home/linuxbrew/.linuxbrew/bin/caprock",
		"/Applications/Caprock.app/Contents/MacOS/caprock":            "/Applications/Caprock.app/Contents/MacOS/caprock",
		"/opt/homebrew/Cellar/caprock/0.134.0/libexec/caprock":        "/opt/homebrew/Cellar/caprock/0.134.0/libexec/caprock",
	} {
		if got := stablePath(filepath.FromSlash(in)); got != filepath.FromSlash(want) {
			t.Errorf("%s -> %s, want %s", in, got, want)
		}
	}
}
