package codex

import (
	"fmt"
	"runtime"
	"sort"
	"sync"
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
	if !Available() {
		t.Skip("no Codex transcripts on this machine")
	}
	ts, err := ListAll(Dirs())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(ts) == 0 {
		t.Skip("Codex directory exists but holds no transcripts")
	}
	// Every transcript is still read, but several at once and beside the
	// package's other tests. On a working machine they are gigabytes (271
	// files, 1.5 GB on the owner's, 2026-10-22), and read one at a time this
	// test alone took 67s, and 463s under -race against the package's 600s
	// timeout. Each file is checked on its own, so the order changes nothing;
	// what a file broke is reported in list order, as before.
	t.Parallel()

	checks := checkAll(ts)
	var parsed, withTokens, withModel, turns int
	for _, c := range checks {
		if !c.parsed {
			// Not every .jsonl under the root has to be a rollout file.
			continue
		}
		parsed++
		if c.tokens {
			withTokens++
		}
		if c.model {
			withModel++
		}
		turns += c.turns
		for _, e := range c.errs {
			t.Error(e)
		}
		if c.fatal != "" {
			t.Fatal(c.fatal)
		}
	}
	if parsed == 0 {
		t.Fatal("no transcript on this machine parsed at all")
	}
	// Every session that carries tokens must name a model, or its cost cannot
	// be computed. This holds because two sources are read: `turn_context`
	// (4 of 100 real transcripts) and `base_instructions.provenance` (96).
	// Reading only the first left 83% of tokens unpriced, and this assertion is
	// what would catch that regressing.
	if withTokens > withModel {
		t.Errorf("%d transcripts carry tokens but only %d name a model — %d sessions cannot be priced",
			withTokens, withModel, withTokens-withModel)
	}
	t.Logf("parsed %d/%d transcripts; %d carry tokens, %d name a model, %d turns total",
		parsed, len(ts), withTokens, withModel, turns)
}

// transcriptCheck is what checkTranscript found in one file: errs are
// reported and the test goes on; fatal stops it.
type transcriptCheck struct {
	parsed, tokens, model bool
	turns                 int
	errs                  []string
	fatal                 string
}

// checkAll runs checkTranscript over every transcript on as many workers as
// there are CPUs, the largest files first so a big one does not start last.
// Results come back in the order of ts. Only the counts and messages are kept,
// never the parsed sessions, so memory stays at a few files' worth.
func checkAll(ts []Transcript) []transcriptCheck {
	out := make([]transcriptCheck, len(ts))
	order := make([]int, len(ts))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return ts[order[a]].Size > ts[order[b]].Size })
	next := make(chan int)
	var wg sync.WaitGroup
	for range min(runtime.GOMAXPROCS(0), len(ts)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				out[i] = checkTranscript(ts[i].Path)
			}
		}()
	}
	for _, i := range order {
		next <- i
	}
	close(next)
	wg.Wait()
	return out
}

// checkTranscript parses one real transcript and checks the invariants every
// real transcript must hold.
func checkTranscript(path string) (c transcriptCheck) {
	s, err := ParseFile(path)
	if err != nil {
		return c
	}
	c.parsed = true
	if s.ID == "" {
		c.errs = append(c.errs, fmt.Sprintf("%s: parsed with no session id", path))
	}
	c.tokens = len(s.Turns) > 0
	c.model = s.Model != ""
	c.turns = len(s.Turns)
	// Keys must be unique within a session or the store drops the later
	// turns as duplicates — silently, because rejecting a duplicate key is
	// exactly what makes re-reading a transcript safe. Keying on the
	// `ordinal` field did this: it is absent from 99 of 100 transcripts, so
	// every turn shared `codex:turn:0` and one session kept 1 turn of 55.
	keys := make(map[string]bool, len(s.Turns)+len(s.Tools))
	for _, tn := range s.Turns {
		if keys[tn.Key] {
			c.fatal = fmt.Sprintf("%s: duplicate turn key %q — later turns would be dropped", path, tn.Key)
			return c
		}
		keys[tn.Key] = true
	}
	for _, tl := range s.Tools {
		if keys[tl.Key] {
			c.fatal = fmt.Sprintf("%s: tool key %q collides", path, tl.Key)
			return c
		}
		keys[tl.Key] = true
	}
	for _, tn := range s.Turns {
		// The arithmetic that decides every cost figure. A negative delta
		// would mean the cumulative-to-delta conversion is wrong, and would
		// silently corrupt a total rather than fail.
		if tn.In < 0 || tn.Out < 0 || tn.CacheRead < 0 || tn.CacheWrite < 0 {
			c.fatal = fmt.Sprintf("%s: negative token delta %+v", path, tn)
			return c
		}
		// Codex counts cached tokens inside its input total, so the cached
		// part can never exceed it. This held on all 239 samples measured;
		// if it ever stops holding, `fresh` is billing the wrong number.
		if tn.CacheRead > tn.In {
			c.fatal = fmt.Sprintf("%s: cached (%d) exceeds input (%d) — the fresh-input subtraction is wrong",
				path, tn.CacheRead, tn.In)
			return c
		}
		if tn.Key == "" {
			c.fatal = fmt.Sprintf("%s: turn with no key would re-import forever", path)
			return c
		}
	}
	return c
}
