package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestPickAComputerByNameOrID(t *testing.T) {
	ids := []string{"aa", "bb", "cc"}
	names := []string{"MacBook", "Mac mini", "macbook"}
	if i, err := pick("bb", ids, names); err != nil || i != 1 {
		t.Fatalf("by id: %d %v", i, err)
	}
	if i, err := pick("MAC MINI", ids, names); err != nil || i != 1 {
		t.Fatalf("by name, any case: %d %v", i, err)
	}
	if _, err := pick("macbook", ids, names); err == nil || !strings.Contains(err.Error(), "aa, cc") {
		t.Fatalf("two of one name must be told apart by id: %v", err)
	}
	if _, err := pick("nope", ids, names); err == nil {
		t.Fatal("an unknown name was picked")
	}
}

func TestShellQuote(t *testing.T) {
	for in, want := range map[string]string{
		"MacBook":                     "MacBook",
		"Mac mini":                    "'Mac mini'",
		"it's":                        `'it'\''s'`,
		"https://m.caprock.dev/#/p?c": "'https://m.caprock.dev/#/p?c'",
	} {
		if got := shellQuote(in); got != want {
			t.Errorf("shellQuote(%q) = %q, want %q", in, got, want)
		}
	}
}

// Linux with lingering off is told how to keep Caprock running with nobody
// logged in; nothing is said otherwise, and nothing is ever run for them.
func TestLingerNote(t *testing.T) {
	old := lingerState
	t.Cleanup(func() { lingerState = old })
	for state, want := range map[string]bool{"no": true, "yes": false, "": false} {
		lingerState = func() string { return state }
		var b bytes.Buffer
		lingerNote(&b)
		if got := strings.Contains(b.String(), "loginctl enable-linger"); got != want {
			t.Errorf("linger %q: said %q", state, b.String())
		}
	}
}
