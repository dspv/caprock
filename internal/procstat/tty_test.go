package procstat

import "testing"

func TestStatTTY(t *testing.T) {
	for line, want := range map[string]bool{
		"123 (node) S 1 123 123 0 -1 4194560 100":        false,
		"124 (claude) S 1 124 124 34816 124 4194560 100": true,
		"125 (we (ird) name) S 1 125 125 34817 1 0 0":    true,
		"bad": false,
	} {
		if got := statTTY(line); got != want {
			t.Errorf("%q: %v, want %v", line, got, want)
		}
	}
}

func TestIsInterpreter(t *testing.T) {
	for name, want := range map[string]bool{"node": true, "/usr/bin/python3.12": true, "uvx": true, "claude": false, "NODE.EXE": true} {
		if got := IsInterpreter(name); got != want {
			t.Errorf("%s: %v, want %v", name, got, want)
		}
	}
}
