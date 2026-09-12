package deepseek

import (
	"embed"
	"testing"
)

// These are checked-in snapshots of the JSONL shapes written by DSH. Tests
// compress them before parsing, matching the on-disk zstd envelope without
// depending on the developer's ~/.dsh or on a locally installed harness.
//
//go:embed testdata/*.jsonl
var testFixtures embed.FS

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := testFixtures.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return string(b)
}
