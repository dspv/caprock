package codex

import (
	"testing"
)

// TestAgainstLocalTranscripts reads whatever Codex transcripts exist on this
// machine. It is a smoke check against a real installation, not a fixture test:
// it skips cleanly where Codex is not installed (CI, most users), and asserts
// only invariants that must hold for any real transcript.
//
// It exists because the fixture was written from what 100 real transcripts
// actually contain, and a fixture can only keep testing that if something also
// checks the real thing occasionally. A fake proves the parser handles the
// shape we imagined, not the shape Codex writes.
func TestAgainstLocalTranscripts(t *testing.T) {
	dir := Dir()
	if dir == "" || !Available() {
		t.Skip("no Codex transcripts on this machine")
	}
	ts, err := List(dir)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(ts) == 0 {
		t.Skip("Codex directory exists but holds no transcripts")
	}

	var parsed, withTokens, withModel int
	for _, f := range ts {
		s, err := ParseFile(f.Path)
		if err != nil {
			// Not every .jsonl under the root has to be a rollout file.
			continue
		}
		parsed++
		if s.ID == "" {
			t.Errorf("%s: parsed with no session id", f.Path)
		}
		if len(s.Turns) > 0 {
			withTokens++
		}
		if s.Model != "" {
			withModel++
		}
		for _, tn := range s.Turns {
			// The arithmetic that decides every cost figure. A negative delta
			// would mean the cumulative-to-delta conversion is wrong, and would
			// silently corrupt a total rather than fail.
			if tn.In < 0 || tn.Out < 0 || tn.CacheRead < 0 || tn.CacheWrite < 0 {
				t.Fatalf("%s: negative token delta %+v", f.Path, tn)
			}
			// Codex counts cached tokens inside its input total, so the cached
			// part can never exceed it. This held on all 239 samples measured;
			// if it ever stops holding, `fresh` is billing the wrong number.
			if tn.CacheRead > tn.In {
				t.Fatalf("%s: cached (%d) exceeds input (%d) — the fresh-input subtraction is wrong",
					f.Path, tn.CacheRead, tn.In)
			}
			if tn.Key == "" {
				t.Fatalf("%s: turn with no key would re-import forever", f.Path)
			}
		}
	}
	if parsed == 0 {
		t.Fatal("no transcript on this machine parsed at all")
	}
	// Not an assertion, a record: most Codex Desktop transcripts carry no
	// turn_context, so most sessions have tokens and no model to price them by.
	// If that ratio ever inverts, the unpriced-turn handling matters less and
	// this log is where the change shows up first.
	t.Logf("parsed %d/%d transcripts; %d carry tokens, %d name a model",
		parsed, len(ts), withTokens, withModel)
}
