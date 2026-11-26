package tcc

import (
	"os"
	"runtime"
	"testing"
)

func TestListedNameIsWhatSystemSettingsShows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("macOS paths: Windows' filepath joins with backslashes")
	}
	for in, want := range map[string]string{
		"/Users/a/Library/Application Support/caprock/bin/Caprock Terminal.app/Contents/MacOS/caprock-pty-host": "Caprock Terminal",
		"/Users/a/.local/share/claude/versions/2.1.332":                                                         "2.1.332",
		"/Users/a/Library/Application Support/caprock/bin/caprock":                                              "caprock",
		"/bin/zsh": "zsh",
		// Not inside Contents/MacOS: not a bundle's executable.
		"/Applications/X.app/Contents/Resources/tool": "tool",
		"": "",
	} {
		if got := ListedName(in); got != want {
			t.Errorf("ListedName(%q) = %q; want %q", in, got, want)
		}
	}
	if b := BundleOf("/A/Caprock Terminal.app/Contents/MacOS/caprock-pty-host"); b != "/A/Caprock Terminal.app" {
		t.Errorf("BundleOf = %q", b)
	}
}

// Reads the kernel only: no prompt. This process answers for itself or for
// whatever started it; either way macOS names something, and nothing
// elsewhere.
func TestResponsibleNamesAProgramOnMacOSOnly(t *testing.T) {
	prog, name := Responsible(os.Getpid())
	if runtime.GOOS != "darwin" {
		if prog != "" || name != "" {
			t.Fatalf("off macOS: %q %q", prog, name)
		}
		return
	}
	if prog == "" || name == "" {
		t.Fatalf("Responsible(self) = %q %q", prog, name)
	}
	if p, n := Responsible(0); p != "" || n != "" {
		t.Fatalf("pid 0: %q %q", p, n)
	}
}
