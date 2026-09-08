package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// write builds a transcript from lines of JSON and returns its path.
func write(t *testing.T, lines ...string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "-Users-x-dev-proj")
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(p, "sess.jsonl")
	if err := os.WriteFile(f, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return f
}

func assistant(ctx int, body string) string {
	return `{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":0,` +
		`"cache_creation_input_tokens":` + itoa(ctx) + `,"cache_read_input_tokens":0,"output_tokens":10},` +
		`"content":[` + body + `]}}`
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// The load-bearing measurement: a tool result costs the growth in context it
// caused, taken from the transcript's own usage — not the size of its bytes.
func TestTokensComeFromUsageDelta(t *testing.T) {
	f := write(t,
		assistant(1000, `{"type":"tool_use","id":"a","name":"Read","input":{"file_path":"x.go"}}`),
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"short"}]}}`,
		// Context grew by 4000 after the read: that is what the read cost,
		// however few bytes the result text happens to be.
		assistant(5000, `{"type":"text","text":"done"}`),
	)
	s, err := ParseSession(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Events) != 1 {
		t.Fatalf("want 1 event, got %d", len(s.Events))
	}
	e := s.Events[0]
	if e.Tokens != 4000 {
		t.Errorf("tokens = %d, want 4000 (the usage delta)", e.Tokens)
	}
	if e.Estimated {
		t.Error("a usage-derived figure must not be marked estimated")
	}
	if e.Class != ClassRead {
		t.Errorf("class = %q, want read", e.Class)
	}
}

// A result with no following assistant turn has no delta to read, so it falls
// back to a size estimate — and says so, because the spec requires estimated
// figures to be distinguishable.
func TestFallbackIsMarkedEstimated(t *testing.T) {
	f := write(t,
		assistant(1000, `{"type":"tool_use","id":"a","name":"Bash","input":{"command":"ls"}}`),
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"`+strings.Repeat("x", 400)+`"}]}}`,
	)
	s, err := ParseSession(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Events) != 1 {
		t.Fatalf("want 1 event, got %d", len(s.Events))
	}
	if !s.Events[0].Estimated {
		t.Error("an event with no usage delta must be marked estimated")
	}
	if s.Events[0].Tokens == 0 {
		t.Error("the fallback still has to produce a figure")
	}
}

// The cost of content is not its size but its size times how many turns carry
// it afterwards. A file read early in a long session is charged many times.
func TestTokenTurnsCountTheRemainingTurns(t *testing.T) {
	lines := []string{
		assistant(1000, `{"type":"tool_use","id":"a","name":"Read","input":{"file_path":"x.go"}}`),
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"body"}]}}`,
	}
	// Four more assistant turns after the read.
	for i := 0; i < 4; i++ {
		lines = append(lines, assistant(2000+i*100, `{"type":"text","text":"t"}`))
	}
	s, err := ParseSession(write(t, lines...))
	if err != nil {
		t.Fatal(err)
	}
	e := s.Events[0]
	if e.TurnsLeft != 4 {
		t.Fatalf("turns_left = %d, want 4", e.TurnsLeft)
	}
	if got, want := e.TokenTurns(), e.Tokens*5; got != want {
		t.Errorf("token-turns = %d, want %d (T x (1+turns_left))", got, want)
	}
}

// Compaction ends the re-reading: content discarded by a compaction is not
// carried by the turns after it, so turns_left stops at the boundary.
func TestTurnsLeftStopsAtCompaction(t *testing.T) {
	lines := []string{
		assistant(1000, `{"type":"tool_use","id":"a","name":"Read","input":{"file_path":"x.go"}}`),
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"body"}]}}`,
		assistant(2000, `{"type":"text","text":"t"}`),
		assistant(2100, `{"type":"text","text":"t"}`),
		`{"type":"system","subtype":"compact_boundary"}`,
		assistant(500, `{"type":"text","text":"after"}`),
		assistant(600, `{"type":"text","text":"after"}`),
	}
	s, err := ParseSession(write(t, lines...))
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Events[0].TurnsLeft; got != 2 {
		t.Errorf("turns_left = %d, want 2 — the turns after a compaction do not carry it", got)
	}
}

// Targeted reads are excluded from routable volume by the spec: they are what
// Claude would still do after a delegation.
func TestTargetedReadsAreSeparated(t *testing.T) {
	f := write(t,
		assistant(1000, `{"type":"tool_use","id":"a","name":"Read","input":{"file_path":"x.go","offset":10,"limit":20}}`),
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"body"}]}}`,
		assistant(2000, `{"type":"text","text":"t"}`),
	)
	s, _ := ParseSession(f)
	if s.Events[0].Class != ClassReadTgt {
		t.Errorf("class = %q, want read_tgt", s.Events[0].Class)
	}
	if s.Events[0].Class.Routable() {
		t.Error("a targeted read must not count as routable volume")
	}
}

// Images are never routable, whichever tool returned them: a screenshot is
// opened to be looked at, and no worker summary substitutes for that. Getting
// this wrong in either direction changes the verdict.
func TestImagesAreNotRoutable(t *testing.T) {
	img := `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}`
	f := write(t,
		assistant(1000, `{"type":"tool_use","id":"a","name":"Read","input":{"file_path":"shot.png"}},`+
			`{"type":"tool_use","id":"b","name":"mcp__x__screenshot","input":{}}`),
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":[`+img+`]}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"b","content":[`+img+`]}]}}`,
		assistant(9000, `{"type":"text","text":"t"}`),
	)
	s, _ := ParseSession(f)
	if len(s.Events) != 2 {
		t.Fatalf("want 2 events, got %d", len(s.Events))
	}
	for _, e := range s.Events {
		if e.Class.Routable() {
			t.Errorf("%s (%s) counted as routable", e.Class, e.Tool)
		}
	}
	if s.Events[0].Class != ClassReadImg || s.Events[1].Class != ClassMCPImage {
		t.Errorf("classes = %q, %q", s.Events[0].Class, s.Events[1].Class)
	}
}

// MCP text results are routable — the same PostToolUse mechanism applies — and
// must be told apart from MCP images, which are not.
func TestMCPTextIsRoutable(t *testing.T) {
	f := write(t,
		assistant(1000, `{"type":"tool_use","id":"a","name":"mcp__srv__query","input":{}}`),
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"rows..."}]}}`,
		assistant(4000, `{"type":"text","text":"t"}`),
	)
	s, _ := ParseSession(f)
	if s.Events[0].Class != ClassMCPText || !s.Events[0].Class.Routable() {
		t.Errorf("class = %q, routable = %v", s.Events[0].Class, s.Events[0].Class.Routable())
	}
}

// When one turn returns several results the usage delta covers all of them and
// cannot be split by measurement, so it is apportioned by size. The totals must
// still add up exactly: an apportionment that loses or invents tokens would
// move the verdict.
func TestBatchedResultsShareTheDeltaWithoutLosingTokens(t *testing.T) {
	small := strings.Repeat("a", 100)
	big := strings.Repeat("b", 300)
	f := write(t,
		assistant(1000, `{"type":"tool_use","id":"a","name":"Bash","input":{"command":"x"}},`+
			`{"type":"tool_use","id":"b","name":"Bash","input":{"command":"y"}}`),
		`{"type":"user","message":{"role":"user","content":[`+
			`{"type":"tool_result","tool_use_id":"a","content":"`+small+`"},`+
			`{"type":"tool_result","tool_use_id":"b","content":"`+big+`"}]}}`,
		assistant(5000, `{"type":"text","text":"t"}`),
	)
	s, _ := ParseSession(f)
	if len(s.Events) != 2 {
		t.Fatalf("want 2 events, got %d", len(s.Events))
	}
	sum := s.Events[0].Tokens + s.Events[1].Tokens
	if sum > 4000 {
		t.Errorf("apportioned %d tokens from a 4000 delta — tokens invented", sum)
	}
	if sum < 3990 {
		t.Errorf("apportioned only %d of a 4000 delta — tokens lost", sum)
	}
	if s.Events[1].Tokens <= s.Events[0].Tokens {
		t.Error("the larger result should carry the larger share")
	}
}

// A shrinking context (after a compaction) must not produce negative costs.
func TestContextShrinkDoesNotProduceNegativeTokens(t *testing.T) {
	f := write(t,
		assistant(9000, `{"type":"tool_use","id":"a","name":"Bash","input":{"command":"x"}}`),
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"out"}]}}`,
		assistant(500, `{"type":"text","text":"after a compaction"}`),
	)
	s, _ := ParseSession(f)
	for _, e := range s.Events {
		if e.Tokens < 0 {
			t.Errorf("negative token cost: %+v", e)
		}
	}
}

// A malformed line must not lose the rest of the transcript.
func TestMalformedLinesAreSkipped(t *testing.T) {
	f := write(t,
		"not json at all",
		assistant(1000, `{"type":"tool_use","id":"a","name":"Read","input":{"file_path":"x"}}`),
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"b"}]}}`,
		`{"type":"assistant","message":`,
		assistant(3000, `{"type":"text","text":"t"}`),
	)
	s, err := ParseSession(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Events) != 1 || s.Events[0].Tokens == 0 {
		t.Errorf("the readable part was lost: %+v", s.Events)
	}
}

// The denominator is every context token-turn, not the sum of tool results.
// Getting this wrong is what makes a share look large.
func TestDenominatorCountsAllContextNotJustToolResults(t *testing.T) {
	f := write(t,
		assistant(10000, `{"type":"text","text":"a long reply with no tools at all"}`),
		assistant(12000, `{"type":"text","text":"another"}`),
	)
	s, _ := ParseSession(f)
	if s.ContextTokenTurns != 22000 {
		t.Errorf("context token-turns = %d, want 22000", s.ContextTokenTurns)
	}
	if len(s.Events) != 0 {
		t.Errorf("no tool results here, got %d", len(s.Events))
	}
}
