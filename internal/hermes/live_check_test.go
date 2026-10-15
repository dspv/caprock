package hermes

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The fixture's schema is a copy, and a copy drifts. Where Hermes Agent is
// installed, this compares it with the CREATE statements in the installed
// source — schema text only: no database is opened and no row is read. When
// Hermes adds a column the reader would want, or drops one it uses, this is
// where it shows. Skipped wherever Hermes is not installed (CI).
func TestFixtureMatchesInstalledHermes(t *testing.T) {
	src := filepath.Join(Home(), "hermes-agent", "hermes_state_common.py")
	if h := os.Getenv("HERMES_SOURCE"); h != "" {
		src = h
	}
	b, err := os.ReadFile(src)
	if err != nil {
		t.Skip("Hermes Agent's source is not installed here")
	}
	for _, table := range []string{"sessions", "messages"} {
		re := regexp.MustCompile(`(?s)CREATE TABLE IF NOT EXISTS ` + table + ` \(.*?\n\);`)
		installed := re.FindString(string(b))
		ours := re.FindString(hermesSchema)
		if installed == "" || ours == "" {
			t.Fatalf("%s: CREATE statement not found (installed %v, fixture %v)", table, installed != "", ours != "")
		}
		if strings.TrimSpace(installed) != strings.TrimSpace(ours) {
			t.Errorf("%s: the installed Hermes schema differs from the fixture; copy it again and check the reader", table)
		}
	}
}
