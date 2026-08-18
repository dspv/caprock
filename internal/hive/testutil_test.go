package hive

import (
	"os"
	"strings"
	"testing"
)

func readFile(t *testing.T, p string) (string, error) {
	t.Helper()
	b, err := os.ReadFile(p)
	return string(b), err
}
func contains(s, sub string) bool { return strings.Contains(s, sub) }
