package deepseek

import (
	"os"
	"testing"
)

// A smoke check against whatever DeepSeek Harness is installed on this machine,
// skipped where there is none. The fixture is written from what real
// transcripts contain; this is what keeps that true — the same role
// Codex's live_check_test.go plays for its own importer.
func TestLiveCheck(t *testing.T) {
	dir := Dir()
	if _, err := os.Stat(dir); err != nil {
		t.Skipf("no DSH sessions at %s", dir)
	}
	ts, err := List(dir)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(ts) == 0 {
		t.Skipf("no DSH transcripts under %s", dir)
	}
	parsed := 0
	for _, tr := range ts {
		s, err := ParseFile(tr.Path)
		if err != nil {
			t.Errorf("parse %s: %v", tr.Path, err)
			continue
		}
		if s.ID == "" {
			t.Errorf("parse %s: empty session id", tr.Path)
			continue
		}
		parsed++
	}
	if parsed == 0 {
		t.Fatalf("none of %d transcripts parsed", len(ts))
	}
	t.Logf("parsed %d of %d transcripts", parsed, len(ts))
}
