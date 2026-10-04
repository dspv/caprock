package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
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
	want := []LimitWindow{{Minutes: 300, UsedPercent: 12.5, ResetsAt: 1788700243}, {Minutes: 10080, UsedPercent: 3.0, ResetsAt: 1788947580}}
	if len(s.Limits.Windows) != 2 || s.Limits.Windows[0] != want[0] || s.Limits.Windows[1] != want[1] {
		t.Errorf("windows: %+v", s.Limits.Windows)
	}
}

// Real `token_count.rate_limits` records, trimmed and anonymised from the
// owner's machine (2026-10-01). Which window sits in `primary` depends on the
// plan, so the parser must read the length, never the slot.
func TestPlanLimitShapesFromRealTranscripts(t *testing.T) {
	const meta = `{"timestamp":"2026-09-17T10:49:19.000Z","type":"session_meta","payload":{"id":"01a0aefc-0000-7000-8000-000000000000","cwd":"/Users/dev/proj"}}`
	tc := func(ts, rl string) string {
		return `{"timestamp":"` + ts + `","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":` + rl + `}}`
	}
	cases := []struct {
		name string
		rl   string
		want []LimitWindow
	}{
		{
			// `prolite`: weekly only, in the primary slot, secondary null.
			name: "prolite",
			rl:   `{"limit_id":"codex","limit_name":null,"primary":{"used_percent":5.0,"window_minutes":10080,"resets_at":1791067416},"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"spend_control_reached":null,"plan_type":"prolite","rate_limit_reached_type":null}`,
			want: []LimitWindow{{Minutes: 10080, UsedPercent: 5, ResetsAt: 1791067416}},
		},
		{
			name: "plus",
			rl:   `{"limit_id":"codex","limit_name":null,"primary":{"used_percent":16.0,"window_minutes":300,"resets_at":1789482335},"secondary":{"used_percent":11.0,"window_minutes":10080,"resets_at":1789833741},"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"spend_control_reached":null,"plan_type":"plus","rate_limit_reached_type":null}`,
			want: []LimitWindow{{Minutes: 300, UsedPercent: 16, ResetsAt: 1789482335}, {Minutes: 10080, UsedPercent: 11, ResetsAt: 1789833741}},
		},
		{
			// CLI 0.4x: no limit_id, odd lengths, resets_at null.
			name: "cli 0.4x",
			rl:   `{"primary":{"used_percent":1.0,"window_minutes":299,"resets_at":null},"secondary":{"used_percent":3.0,"window_minutes":10079,"resets_at":null}}`,
			want: []LimitWindow{{Minutes: 299, UsedPercent: 1}, {Minutes: 10079, UsedPercent: 3}},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			src := meta + "\n" + tc("2026-10-01T12:06:17.317Z", c.rl) + "\n"
			s, err := Parse(strings.NewReader(src), "x")
			if err != nil {
				t.Fatal(err)
			}
			if s.Limits == nil || len(s.Limits.Windows) != len(c.want) {
				t.Fatalf("limits: %+v", s.Limits)
			}
			for i := range c.want {
				if s.Limits.Windows[i] != c.want[i] {
					t.Errorf("window %d: %+v, want %+v", i, s.Limits.Windows[i], c.want[i])
				}
			}
		})
	}

	// A sample for another limit (`premium`, which carried no windows) and a
	// null rate_limits must not displace the plan's own sample before them.
	src := meta + "\n" + tc("2026-09-18T18:12:29.176Z", cases[1].rl) + "\n" +
		tc("2026-09-18T18:12:51.817Z", `{"limit_id":"premium","limit_name":null,"primary":null,"secondary":null,"plan_type":"plus"}`) + "\n" +
		tc("2026-09-18T18:13:00.000Z", `null`) + "\n"
	s, err := Parse(strings.NewReader(src), "x")
	if err != nil {
		t.Fatal(err)
	}
	if s.Limits == nil || len(s.Limits.Windows) != 2 || s.Limits.Windows[0].Minutes != 300 {
		t.Fatalf("plan sample lost to a later non-plan one: %+v", s.Limits)
	}
}

func TestWindowNames(t *testing.T) {
	for m, want := range map[int]string{300: "five_hour", 299: "five_hour", 10080: "seven_day", 10079: "seven_day", 60: "", 1440: "", 43200: ""} {
		if got := windowName(m); got != want {
			t.Errorf("windowName(%d) = %q, want %q", m, got, want)
		}
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

func TestDirsRespectEnv(t *testing.T) {
	t.Setenv(EnvDir, "/tmp/somewhere")
	if d := Dirs(); len(d) != 1 || d[0] != "/tmp/somewhere" {
		t.Errorf("env override ignored: %q", d)
	}
}

// CODEX_HOME is Codex's documented override of ~/.codex; both the live and
// the archived transcripts live under it.
func TestDirsFollowCodexHome(t *testing.T) {
	t.Setenv(EnvDir, "")
	home := filepath.Join(t.TempDir(), "codex-home")
	t.Setenv(EnvHome, home)
	want := []string{filepath.Join(home, "sessions"), filepath.Join(home, "archived_sessions")}
	if d := Dirs(); len(d) != 2 || d[0] != want[0] || d[1] != want[1] {
		t.Errorf("Dirs() = %q, want %q", d, want)
	}
}

// Without CODEX_HOME the root is ~/.codex. os.UserHomeDir reads HOME on Unix
// and USERPROFILE on Windows, so both are set.
func TestDirsDefaultToDotCodex(t *testing.T) {
	t.Setenv(EnvDir, "")
	t.Setenv(EnvHome, "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if d := Dirs(); len(d) != 2 || d[0] != filepath.Join(home, ".codex", "sessions") || d[1] != filepath.Join(home, ".codex", "archived_sessions") {
		t.Errorf("Dirs() = %q", d)
	}
}

func TestListAllMergesRootsAndToleratesAMissingOne(t *testing.T) {
	home := t.TempDir()
	live := filepath.Join(home, "sessions", "2026", "09", "06")
	arch := filepath.Join(home, "archived_sessions")
	for _, d := range []string{live, arch} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []string{filepath.Join(live, "rollout-a.jsonl"), filepath.Join(arch, "rollout-b.jsonl")} {
		if err := os.WriteFile(p, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	ts, err := ListAll([]string{filepath.Join(home, "sessions"), arch, filepath.Join(home, "nope")})
	if err != nil || len(ts) != 2 {
		t.Fatalf("ListAll: %v %v", ts, err)
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

// Some transcripts report a total with every component at zero — 114 of 233
// token samples on the machine this was built against, one of them 4.4M
// tokens. Reading only the components stored those turns as if they had used
// nothing, which is how $23 of real usage came to show as $0.53.
func TestTotalWithNoBreakdownIsNotDiscarded(t *testing.T) {
	body := `{"type":"session_meta","payload":{"session_id":"s","cwd":"/w","base_instructions":{"provenance":{"type":"model","model":"gpt-5-codex"}}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":0,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":2528}}}}`
	s, err := Parse(strings.NewReader(body), "x")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Turns) != 1 {
		t.Fatalf("want 1 turn, got %d", len(s.Turns))
	}
	tn := s.Turns[0]
	if tn.In != 2528 {
		t.Errorf("the total should be carried as input, got In=%d", tn.In)
	}
	if !tn.TotalOnly {
		t.Error("the turn should be marked as having no breakdown, so its cost reads as an upper bound")
	}
	// Never credited a cache discount it was not reported to have earned.
	if tn.CacheRead != 0 || tn.CacheWrite != 0 {
		t.Errorf("a total with no breakdown must not be split across kinds: %+v", tn)
	}
}

// A turn that really did use nothing stays empty and unmarked — the fallback
// must not manufacture usage out of a zero total.
func TestGenuinelyEmptyTurnIsNotInflated(t *testing.T) {
	body := `{"type":"session_meta","payload":{"session_id":"s","cwd":"/w"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}}`
	s, err := Parse(strings.NewReader(body), "x")
	if err != nil {
		t.Fatal(err)
	}
	for _, tn := range s.Turns {
		if tn.TotalOnly || tn.In != 0 {
			t.Errorf("a zero total invented usage: %+v", tn)
		}
	}
}

// A turn that has a breakdown keeps it, untouched by the fallback.
func TestBreakdownIsPreferredOverTheTotal(t *testing.T) {
	body := `{"type":"session_meta","payload":{"session_id":"s","cwd":"/w"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":10,"total_tokens":110}}}}`
	s, err := Parse(strings.NewReader(body), "x")
	if err != nil {
		t.Fatal(err)
	}
	tn := s.Turns[0]
	if tn.In != 100 || tn.CacheRead != 80 || tn.Out != 10 || tn.TotalOnly {
		t.Errorf("the breakdown was overwritten: %+v", tn)
	}
}

// Codex compresses every rollout untouched for a week into `<name>.jsonl.zst`
// and deletes the plain file. A reader that lists only `.jsonl` keeps a week of
// history; this pins that the compressed file is listed and parses to the same
// session as the plain one.
func TestCompressedRolloutIsListedAndParsed(t *testing.T) {
	raw, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	zpath := filepath.Join(dir, "rollout-basic.jsonl.zst")
	enc, err := zstd.NewWriter(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(zpath, enc.EncodeAll(raw, nil), 0o600); err != nil {
		t.Fatal(err)
	}
	ts, err := List(dir)
	if err != nil || len(ts) != 1 || ts[0].Path != zpath {
		t.Fatalf("List missed the compressed rollout: %v %v", ts, err)
	}
	plain, err := ParseFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	packed, err := ParseFile(zpath)
	if err != nil {
		t.Fatal(err)
	}
	if packed.ID != plain.ID || len(packed.Turns) != len(plain.Turns) || len(packed.Tools) != len(plain.Tools) {
		t.Fatalf("compressed parse differs: id %q/%q turns %d/%d tools %d/%d",
			packed.ID, plain.ID, len(packed.Turns), len(plain.Turns), len(packed.Tools), len(plain.Tools))
	}
	if len(plain.Turns) == 0 {
		t.Fatal("fixture has no turns; the comparison proves nothing")
	}
	if got := rolloutName(zpath); got != "rollout-basic" {
		t.Errorf("rolloutName = %q", got)
	}
}

// A response's items come before the token_count that bills it, so a call
// belongs to the first turn after it; one with no turn after it stays unlinked.
func TestToolCallBelongsToTheNextTurn(t *testing.T) {
	s := &Session{
		Turns: []Turn{{Key: "t3", Line: 3}, {Key: "t9", Line: 9}},
		Tools: []ToolCall{{Line: 1}, {Line: 5}, {Line: 6}, {Line: 12}},
	}
	linkToolsToTurns(s)
	want := []string{"t3", "t9", "t9", ""}
	for i, c := range s.Tools {
		if c.TurnKey != want[i] {
			t.Errorf("tool on line %d: TurnKey = %q, want %q", c.Line, c.TurnKey, want[i])
		}
	}
}
