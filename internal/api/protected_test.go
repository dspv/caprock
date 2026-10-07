package api

import "testing"

func TestProtectedDirsAreLeftAloneOnMacOS(t *testing.T) {
	home := "/Users/u"
	for dir, want := range map[string]bool{
		"/Users/u/Documents/Codex/2026-09-06/x20":  true,
		"/Users/u/Downloads/caprock":               true,
		"/Users/u/Desktop":                         true,
		"/Users/u/Library/Mobile Documents/x/proj": true,
		"/Volumes/External/repo":                   true,
		"/Users/u/dev/caprock":                     false,
		"/Users/u/DocumentsArchive/repo":           false,
		"/Users/u/Library/Application Support/x":   false,
		"":                                         false,
	} {
		if got := protectedUnder("darwin", home, dir); got != want {
			t.Errorf("darwin %q: got %v, want %v", dir, got, want)
		}
	}
	if protectedUnder("linux", home, "/Users/u/Documents/repo") {
		t.Error("only macOS asks")
	}
}
