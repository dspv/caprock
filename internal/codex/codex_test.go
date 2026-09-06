package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const fixture = "../../testdata/codex/rollout-basic.jsonl"

// The fixture reproduces every shape measured against 100 real transcripts:
// a session_meta, a model that appears only in turn_context, duplicated
// token_count samples, both spellings of a tool call, plan limits, and a
// truncated final line.
func TestParseFixture(t *testing.T) {
	s, err := ParseFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if s.ID != "01a075d9-2b63-7200-b3e2-bfeac9416f15" {
		t.Errorf("session id: %q", s.ID)
	}
	if s.Cwd != "/Users/dev/proj" || s.Model != "gpt-5-codex" {
		t.Errorf("cwd/model: %q %q", s.Cwd, s.Model)
	}
	if s.CLIVersion != "0.150.0-alpha.8" || s.Originator != "Codex Desktop" {
		t.Errorf("version/originator: %q %q", s.CLIVersion, s.Originator)
	}
	if s.StartedAt.IsZero() {
		t.Error("no start time")
	}
}

// The measurement this whole package turns on. Codex emits the same cumulative
// figures twice in a row, so summing its per-turn field double-counts — on one
// real session that gave 261,111 tokens against a true 137,739. Deltas come
// from the cumulative total instead, and the duplicate must contribute nothing.
func TestDuplicateTokenSamplesAreNotCountedTwice(t *testing.T) {
	s, err := ParseFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Turns) != 2 {
		t.Fatalf("want 2 turns (the duplicate dropped), got %d", len(s.Turns))
	}
	// First turn is the whole first sample.
	if s.Turns[0].In != 1000 || s.Turns[0].CacheRead != 800 || s.Turns[0].Out != 100 {
		t.Errorf("turn 0: %+v", s.Turns[0])
	}
	// Second is the difference between the cumulative samples, not the
	// transcript's own `last_token_usage`.
	if s.Turns[1].In != 1500 || s.Turns[1].CacheRead != 1200 || s.Turns[1].Out != 150 {
		t.Errorf("turn 1: %+v", s.Turns[1])
	}
	// And the deltas reconstruct the final cumulative total exactly, which is
	// the property checked against all 92 real sessions that carry one.
	var in, cr, out int64
	for _, tn := range s.Turns {
		in += tn.In
		cr += tn.CacheRead
		out += tn.Out
	}
	if in != 2500 || cr != 2000 || out != 250 {
		t.Errorf("deltas do not sum to the final total: in=%d cache=%d out=%d", in, cr, out)
	}
}

// Both spellings of a tool call are read, and their arguments survive.
func TestToolCalls(t *testing.T) {
	s, err := ParseFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Tools) != 2 {
		t.Fatalf("want 2 tool calls, got %d", len(s.Tools))
	}
	names := []string{s.Tools[0].Name, s.Tools[1].Name}
	if names[0] != "exec" || names[1] != "shell" {
		t.Errorf("tool names: %v", names)
	}
	if !strings.Contains(s.Tools[0].Input, "ls -la") {
		t.Errorf("custom_tool_call input lost: %q", s.Tools[0].Input)
	}
	if !strings.Contains(s.Tools[1].Input, "go test") {
		t.Errorf("function_call arguments lost: %q", s.Tools[1].Input)
	}
}

// Plan limits are the free win: Codex reports the same two windows Claude Code
// does, and unlike Claude Code it reports them in the transcript rather than
// only to a status-line command.
func TestPlanLimits(t *testing.T) {
	s, err := ParseFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if s.Limits == nil {
		t.Fatal("no limits parsed")
	}
	if s.Limits.PrimaryPct != 12.5 || s.Limits.PrimaryMinutes != 300 {
		t.Errorf("primary: %+v", s.Limits)
	}
	if s.Limits.SecondaryPct != 3.0 || s.Limits.SecondaryMinutes != 10080 {
		t.Errorf("secondary: %+v", s.Limits)
	}
}

// A transcript is written by another program while it runs, so its last line is
// routinely a partial write. Refusing the file for that would make a live
// session invisible until it ended.
func TestPartialFinalLineIsTolerated(t *testing.T) {
	b, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(strings.TrimRight(string(b), "\n"), `"type":"event_ms`) {
		t.Fatal("fixture no longer ends in a partial line; this test is not testing anything")
	}
	s, err := ParseFile(fixture)
	if err != nil {
		t.Fatalf("partial line failed the whole file: %v", err)
	}
	if len(s.Turns) == 0 {
		t.Error("everything before the partial line should still be read")
	}
}

// Keys are derived from the record ordinal, which never changes in an
// append-only file — this is what makes re-reading a transcript idempotent.
func TestKeysAreStableAcrossReads(t *testing.T) {
	a, err := ParseFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	b, err := ParseFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	for i := range a.Turns {
		if a.Turns[i].Key != b.Turns[i].Key || a.Turns[i].Key == "" {
			t.Fatalf("turn key unstable or empty: %q vs %q", a.Turns[i].Key, b.Turns[i].Key)
		}
	}
	// A turn key and a tool key from the same ordinal must not collide.
	seen := map[string]bool{}
	for _, tn := range a.Turns {
		seen[tn.Key] = true
	}
	for _, tl := range a.Tools {
		if seen[tl.Key] {
			t.Fatalf("tool key collides with a turn key: %q", tl.Key)
		}
	}
}

func TestNotATranscript(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "junk.jsonl")
	if err := os.WriteFile(p, []byte("{\"hello\":1}\nnot json\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseFile(p); err == nil {
		t.Fatal("a file with no session_meta should not parse as a session")
	}
}

// delta is the arithmetic the token counts depend on; its edge cases decide
// whether a cost figure is right.
func TestDelta(t *testing.T) {
	u := func(total int64) *usage { return &usage{TotalTokens: total, InputTokens: total} }

	if d, ok := delta(nil, u(100)); !ok || d.TotalTokens != 100 {
		t.Errorf("first sample should be taken whole: %+v %v", d, ok)
	}
	if _, ok := delta(u(100), u(100)); ok {
		t.Error("an identical repeat must contribute nothing")
	}
	if d, ok := delta(u(100), u(250)); !ok || d.TotalTokens != 150 {
		t.Errorf("delta: %+v %v", d, ok)
	}
	// A total that goes backwards is treated as a fresh start, never as a
	// negative delta — a negative token count would silently corrupt a cost.
	if d, ok := delta(u(500), u(30)); !ok || d.TotalTokens != 30 {
		t.Errorf("backwards total should restart, got %+v %v", d, ok)
	}
	if _, ok := delta(u(10), nil); ok {
		t.Error("a nil sample is not a delta")
	}
}

func TestList(t *testing.T) {
	dir := t.TempDir()
	deep := filepath.Join(dir, "2026", "09", "06")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"rollout-a.jsonl", "rollout-b.jsonl", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(deep, n), []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	ts, err := List(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(ts) != 2 {
		t.Fatalf("want 2 .jsonl files, got %d", len(ts))
	}
	// A missing directory is the normal case on a machine without Codex, and
	// must be empty rather than an error.
	got, err := List(filepath.Join(dir, "nope"))
	if err != nil || len(got) != 0 {
		t.Fatalf("missing dir: %v %v", got, err)
	}
	if got, err := List(""); err != nil || got != nil {
		t.Fatalf("empty dir: %v %v", got, err)
	}
}

func TestDirRespectsEnv(t *testing.T) {
	t.Setenv(EnvDir, "/tmp/somewhere")
	if Dir() != "/tmp/somewhere" {
		t.Errorf("env override ignored: %q", Dir())
	}
}

// The model comes from base_instructions.provenance when turn_context is
// absent, which on real data is nearly always: turn_context appears in 4 of
// 100 transcripts, provenance in 96, and between them every session that
// carries tokens can be priced. Reading only the obvious source left 83% of
// tokens with no cost.
func TestModelFromProvenanceWhenTurnContextIsAbsent(t *testing.T) {
	lines := readLines(t)
	var kept []string
	for _, l := range lines {
		if strings.Contains(l, `"turn_context"`) {
			continue
		}
		kept = append(kept, l)
	}
	s, err := Parse(strings.NewReader(strings.Join(kept, "\n")), "x")
	if err != nil {
		t.Fatal(err)
	}
	if s.Model != "gpt-5-codex" {
		t.Fatalf("model should come from provenance, got %q", s.Model)
	}
}

// turn_context wins where both exist: provenance describes the prompt the
// session was built with, turn_context the turn actually running. They agreed
// in every real transcript carrying both, and no model changed mid-session in
// 100 files — but the per-turn value is the one to trust if that ever changes.
func TestTurnContextBeatsProvenance(t *testing.T) {
	lines := readLines(t)
	for i, l := range lines {
		if strings.Contains(l, `"turn_context"`) {
			lines[i] = strings.Replace(l, `"gpt-5-codex"`, `"gpt-5.6-sol"`, 1)
		}
	}
	s, err := Parse(strings.NewReader(strings.Join(lines, "\n")), "x")
	if err != nil {
		t.Fatal(err)
	}
	if s.Model != "gpt-5.6-sol" {
		t.Fatalf("turn_context should win over provenance, got %q", s.Model)
	}
}

// Provenance carries a type. Only `model` names a model id; anything else
// describes the instructions some other way and must not be read as one.
func TestProvenanceOfAnotherTypeIsNotAModel(t *testing.T) {
	lines := readLines(t)
	var kept []string
	for _, l := range lines {
		if strings.Contains(l, `"turn_context"`) {
			continue
		}
		kept = append(kept, strings.Replace(l, `"type": "model"`, `"type": "preset"`, 1))
	}
	s, err := Parse(strings.NewReader(strings.Join(kept, "\n")), "x")
	if err != nil {
		t.Fatal(err)
	}
	if s.Model != "" {
		t.Fatalf("a non-model provenance was read as a model: %q", s.Model)
	}
}

func readLines(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, l := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}

// Keys come from the record's line, not from its `ordinal` field.
//
// Ordinal looked like the obvious key and is present in 1 of 100 real
// transcripts. In the other 99 it decoded to 0 for every record, so every turn
// in a session shared the key `codex:turn:0` and the store — correctly —
// rejected all but the first as duplicates. One real session kept 1 of its 55
// turns, and the tokens went with them. Nothing errored; the data was just
// quietly absent.
func TestKeysDoNotDependOnTheOrdinalField(t *testing.T) {
	lines := readLines(t)
	var stripped []string
	for _, l := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			stripped = append(stripped, l) // the deliberate partial line
			continue
		}
		delete(m, "ordinal")
		b, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		stripped = append(stripped, string(b))
	}
	s, err := Parse(strings.NewReader(strings.Join(stripped, "\n")), "x")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Turns) < 2 {
		t.Fatalf("fixture needs at least two turns to detect a collision, got %d", len(s.Turns))
	}
	seen := map[string]bool{}
	for _, tn := range s.Turns {
		if seen[tn.Key] {
			t.Fatalf("two turns share the key %q with no ordinal present — every turn after the first would be dropped as a duplicate", tn.Key)
		}
		seen[tn.Key] = true
	}
	for _, tl := range s.Tools {
		if seen[tl.Key] {
			t.Fatalf("a tool call collides with a turn key: %q", tl.Key)
		}
		seen[tl.Key] = true
	}
}
