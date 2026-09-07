package main

import (
	"math"
	"strings"
	"testing"
)

func bashCall(ctx int, cmd string) string {
	return `{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5","usage":{"input_tokens":0,` +
		`"cache_creation_input_tokens":0,"cache_read_input_tokens":` + itoa(ctx) + `,"output_tokens":10},` +
		`"content":[{"type":"tool_use","id":"t` + itoa(ctx) + `","name":"Bash","input":{"command":"` + cmd + `"}}]}}`
}

func bashResult(ctx int) string {
	return `{"type":"user","message":{"role":"user","content":[{"type":"tool_result",` +
		`"tool_use_id":"t` + itoa(ctx) + `","content":"ok"}]}}`
}

func userSays(text string) string {
	return `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"` + text + `"}]}}`
}

// A series is a run of consecutive tool calls; a human speaking ends it. The
// whole argument rests on this boundary, because a loop is exactly the thing
// that runs without anyone intervening.
func TestUserMessageEndsASeries(t *testing.T) {
	lines := []string{}
	for i := 1; i <= 3; i++ {
		lines = append(lines, bashCall(100000+i, "go test ./..."), bashResult(100000+i))
	}
	lines = append(lines, userSays("now do something else"))
	for i := 1; i <= 4; i++ {
		lines = append(lines, bashCall(200000+i, "go build ./..."), bashResult(200000+i))
	}
	s, err := ParseSession(write(t, lines...))
	if err != nil {
		t.Fatal(err)
	}
	got := DetectSeries(*s, DefaultRule)
	if len(got) != 2 {
		t.Fatalf("want 2 series split by the user message, got %d", len(got))
	}
	if got[0].N != 3 || got[1].N != 4 {
		t.Errorf("series lengths = %d, %d; want 3, 4", got[0].N, got[1].N)
	}
}

// A compaction also ends a series: the context it was paying for is gone, so
// the calls after it are a different loop at a different price.
func TestCompactionEndsASeries(t *testing.T) {
	lines := []string{}
	for i := 1; i <= 3; i++ {
		lines = append(lines, bashCall(300000+i, "go test ./..."), bashResult(300000+i))
	}
	lines = append(lines, `{"type":"system","subtype":"compact_boundary"}`)
	for i := 1; i <= 3; i++ {
		lines = append(lines, bashCall(50000+i, "go test ./..."), bashResult(50000+i))
	}
	s, _ := ParseSession(write(t, lines...))
	got := DetectSeries(*s, DefaultRule)
	if len(got) != 2 {
		t.Fatalf("want 2 series split by the compaction, got %d", len(got))
	}
	if got[1].CStart > 100000 {
		t.Errorf("the post-compaction series should start from a small context, got %d", got[1].CStart)
	}
}

// The Stage 0 kill criterion is stated against n>=5 at C_start>=200k, so the
// eligibility rule has to be exactly that and say why when it refuses.
func TestEligibilityRule(t *testing.T) {
	long := func(n, ctx int, cmd string) Series {
		lines := []string{}
		for i := 1; i <= n; i++ {
			lines = append(lines, bashCall(ctx+i, cmd), bashResult(ctx+i))
		}
		s, _ := ParseSession(write(t, lines...))
		got := DetectSeries(*s, DefaultRule)
		if len(got) == 0 {
			t.Fatal("no series detected")
		}
		return got[0]
	}
	if sr := long(6, 250000, "go test ./..."); !sr.Eligible {
		t.Errorf("6 calls at 250k should be eligible, refused: %q", sr.Why)
	}
	if sr := long(3, 250000, "go test ./..."); sr.Eligible || sr.Why != "too short" {
		t.Errorf("3 calls should be too short, got eligible=%v why=%q", sr.Eligible, sr.Why)
	}
	if sr := long(6, 50000, "go test ./..."); sr.Eligible || sr.Why != "context below threshold" {
		t.Errorf("6 calls at 50k should be below threshold, got eligible=%v why=%q", sr.Eligible, sr.Why)
	}
}

// A series that edits files stays in the main context: the spec is explicit
// that editing must not be delegated, and a classifier that gets this wrong
// would propose moving real work into a subagent.
func TestSeriesWithEditsIsNotEligible(t *testing.T) {
	lines := []string{}
	for i := 1; i <= 3; i++ {
		lines = append(lines, bashCall(250000+i, "go test ./..."), bashResult(250000+i))
	}
	lines = append(lines,
		`{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5","usage":{"input_tokens":0,`+
			`"cache_creation_input_tokens":0,"cache_read_input_tokens":260000,"output_tokens":5},`+
			`"content":[{"type":"tool_use","id":"e1","name":"Edit","input":{"file_path":"x.go"}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"e1","content":"done"}]}}`)
	for i := 4; i <= 6; i++ {
		lines = append(lines, bashCall(260000+i, "go test ./..."), bashResult(260000+i))
	}
	s, _ := ParseSession(write(t, lines...))
	got := DetectSeries(*s, DefaultRule)
	if len(got) != 1 {
		t.Fatalf("want 1 series, got %d", len(got))
	}
	if got[0].Eligible || got[0].Why != "edits pre-existing files" {
		t.Errorf("a series editing files it did not create must not be eligible: eligible=%v why=%q",
			got[0].Eligible, got[0].Why)
	}
	if !got[0].EditLoop || got[0].SelfContained {
		t.Errorf("it should be classed as an edit-loop: editLoop=%v selfContained=%v",
			got[0].EditLoop, got[0].SelfContained)
	}
}

// The rule that decides the verdict: a series that only edits what it first
// wrote owns everything it touches, so isolating it cannot clobber work that
// predates it. Refusing these is what put the coverage figure at 6%.
func TestSeriesEditingOnlyItsOwnFilesIsSelfContained(t *testing.T) {
	writeCall := func(id, path string, ctx int) string {
		return `{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5","usage":{"input_tokens":0,` +
			`"cache_creation_input_tokens":0,"cache_read_input_tokens":` + itoa(ctx) + `,"output_tokens":5},` +
			`"content":[{"type":"tool_use","id":"` + id + `","name":"Write","input":{"file_path":"` + path + `"}}]}}`
	}
	editCall := func(id, path string, ctx int) string {
		return `{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5","usage":{"input_tokens":0,` +
			`"cache_creation_input_tokens":0,"cache_read_input_tokens":` + itoa(ctx) + `,"output_tokens":5},` +
			`"content":[{"type":"tool_use","id":"` + id + `","name":"Edit","input":{"file_path":"` + path + `"}}]}}`
	}
	res := func(id string) string {
		return `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"` + id + `","content":"ok"}]}}`
	}

	t.Run("writes then edits the same file", func(t *testing.T) {
		lines := []string{writeCall("w1", "/tmp/new.go", 250000), res("w1"), editCall("e1", "/tmp/new.go", 250100), res("e1")}
		for i := 1; i <= 4; i++ {
			lines = append(lines, bashCall(250200+i, "go test ./..."), bashResult(250200+i))
		}
		s, _ := ParseSession(write(t, lines...))
		got := DetectSeries(*s, DefaultRule)
		if len(got) != 1 {
			t.Fatalf("want 1 series, got %d", len(got))
		}
		if !got[0].SelfContained || got[0].EditLoop {
			t.Errorf("selfContained=%v editLoop=%v, want true/false", got[0].SelfContained, got[0].EditLoop)
		}
		if !got[0].Eligible {
			t.Errorf("a self-contained loop should be eligible, refused: %q", got[0].Why)
		}
	})

	t.Run("edits a file it never wrote", func(t *testing.T) {
		lines := []string{writeCall("w1", "/tmp/new.go", 250000), res("w1"), editCall("e1", "/tmp/other.go", 250100), res("e1")}
		for i := 1; i <= 4; i++ {
			lines = append(lines, bashCall(250200+i, "go test ./..."), bashResult(250200+i))
		}
		s, _ := ParseSession(write(t, lines...))
		got := DetectSeries(*s, DefaultRule)
		if got[0].SelfContained || !got[0].EditLoop {
			t.Errorf("editing an unwritten file must not be self-contained: %+v", got[0])
		}
	})

	t.Run("an edit with no recorded path counts as foreign", func(t *testing.T) {
		// Unknown provenance is treated as the worse case, because this rule
		// decides whether real work is moved into a subagent.
		lines := []string{
			`{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5","usage":{"input_tokens":0,` +
				`"cache_creation_input_tokens":0,"cache_read_input_tokens":250000,"output_tokens":5},` +
				`"content":[{"type":"tool_use","id":"e1","name":"Edit","input":{}}]}}`,
			res("e1"),
		}
		for i := 1; i <= 5; i++ {
			lines = append(lines, bashCall(250200+i, "go test ./..."), bashResult(250200+i))
		}
		s, _ := ParseSession(write(t, lines...))
		got := DetectSeries(*s, DefaultRule)
		if got[0].SelfContained || !got[0].EditLoop {
			t.Errorf("an edit with no path must count as foreign: %+v", got[0])
		}
	})
}

func TestCommandClassification(t *testing.T) {
	for cmd, want := range map[string]string{
		"go test ./internal/...":       "test",
		"cd /repo && go test ./...":    "test",
		"npx vitest run src/x.test.ts": "test",
		"go build ./cmd/x":             "build",
		"make check":                   "build",
		"git diff --stat":              "vcs",
		"grep -rn foo internal/":       "search",
		"npm install":                  "pkg",
		"./bin/caprock up --port 4173": "run",
		"cd /x && cd /y && git status": "vcs",
	} {
		if got := classifyCommand(cmd); got != want {
			t.Errorf("classifyCommand(%q) = %q, want %q", cmd, got, want)
		}
	}
}

// A series with no dominant class is "mixed" rather than confidently wrong.
// A classifier that names a class it cannot justify is worse than one that
// admits it does not know, because the UI has to explain the label.
func TestMixedSeriesIsNotGivenAConfidentClass(t *testing.T) {
	got := classifySeries([]string{"go test ./...", "git diff", "grep -rn x .", "npm install"})
	if got != "mixed" {
		t.Errorf("class = %q, want mixed — no class holds a majority", got)
	}
	if got := classifySeries([]string{"go test ./...", "go test ./x", "go test ./y", "git diff"}); got != "test" {
		t.Errorf("class = %q, want test — three of four calls are tests", got)
	}
}

// The isolation counterfactual is the number the whole spec turns on, so it is
// checked against a hand-computed case rather than against itself.
func TestIsolationSavingIsTheContextNotThePrice(t *testing.T) {
	// Five calls at a flat 400k context, each returning 1k tokens, nothing
	// carried afterwards.
	var ev []Event
	for i := 0; i < 5; i++ {
		ev = append(ev, Event{ContextAtCall: 400_000, Tokens: 1_000, TurnsLeft: 0})
	}
	sr := Series{N: 5, CStart: 400_000, TurnsEnd: 0}
	opus := Prices{In: 5.00}

	// Same model on both sides: the price per token is identical, so any saving
	// is purely the context that is no longer re-read.
	iso := IsolateSeries(sr, ev, opus, opus, 25_000, 1_000, 500)

	// Actual: 5 x 400k cache reads + 5 x 1k cache writes.
	wantActual := 5*400_000*0.5/1e6 + 5*1_000*6.25/1e6
	if math.Abs(iso.CostActual-wantActual) > 1e-9 {
		t.Errorf("cost_actual = %.6f, want %.6f", iso.CostActual, wantActual)
	}
	if iso.Saved <= 0 {
		t.Fatalf("isolating a 400k loop should save something, got %.6f", iso.Saved)
	}
	if iso.Saved/iso.CostActual < 0.5 {
		t.Errorf("saving is only %.0f%% of a 400k-context loop; the context term should dominate",
			100*iso.Saved/iso.CostActual)
	}
}

// Isolation must be able to come out negative: a short loop in a small context
// costs more to delegate than to run, and a counterfactual that cannot say so
// is not measuring anything.
func TestIsolationCanCostMoreThanItSaves(t *testing.T) {
	var ev []Event
	for i := 0; i < 2; i++ {
		ev = append(ev, Event{ContextAtCall: 10_000, Tokens: 200, TurnsLeft: 50})
	}
	sr := Series{N: 2, CStart: 10_000, TurnsEnd: 50}
	opus := Prices{In: 5.00}
	iso := IsolateSeries(sr, ev, opus, opus, 25_000, 1_000, 500)
	if iso.Saved >= 0 {
		t.Errorf("a 2-call loop in a 10k context should not pay to isolate: saved %.6f", iso.Saved)
	}
}

// A cheaper subagent model saves more than the same model, but the difference
// must be second-order: the spec's open question 3 asks whether the model
// choice matters or whether isolation alone captures the saving.
func TestCheaperSubagentIsASecondOrderKnob(t *testing.T) {
	var ev []Event
	for i := 0; i < 10; i++ {
		ev = append(ev, Event{ContextAtCall: 380_000, Tokens: 600, TurnsLeft: 0})
	}
	sr := Series{N: 10, CStart: 380_000}
	opus, haiku := Prices{In: 5.00}, Prices{In: 1.00}

	same := IsolateSeries(sr, ev, opus, opus, 25_000, 1_000, 500)
	cheap := IsolateSeries(sr, ev, opus, haiku, 25_000, 1_000, 500)

	if cheap.Saved <= same.Saved {
		t.Error("a cheaper subagent should save at least as much")
	}
	// Same-model isolation should already capture the bulk of it.
	if same.Saved/cheap.Saved < 0.8 {
		t.Errorf("same-model isolation captures only %.0f%% of the cheap-model saving; "+
			"if the model choice dominates, the spec's framing is wrong",
			100*same.Saved/cheap.Saved)
	}
}

// Compaction saves on the calls after it and costs a summary write; both sides
// have to be in the number or it is a sales figure.
func TestCompactionCounterfactualChargesForItsOwnSummary(t *testing.T) {
	var ev []Event
	for i := 0; i < 40; i++ {
		ev = append(ev, Event{ContextAtCall: 300_000})
	}
	opus := Prices{In: 5.00}
	saved := CompactionAt(ev, 10, opus, 0.25, 8_000)
	if saved <= 0 {
		t.Fatalf("compacting a 300k context with 29 calls left should pay: %.4f", saved)
	}
	// The summary is not free, and the counterfactual has to charge for it.
	// Checked as arithmetic rather than as a guess about where the crossover
	// falls: at 300k context one remaining call already saves $0.1125 against
	// a $0.05 summary, so "one call left" still pays. The point where it stops
	// paying is a smaller context, and that is what this pins.
	small := make([]Event, 40)
	for i := range small {
		small[i] = Event{ContextAtCall: 20_000}
	}
	if late := CompactionAt(small, 38, opus, 0.25, 8_000); late >= 0 {
		t.Errorf("compacting a 20k context with one call left must not pay: %.4f", late)
	}
	// And the charge is real: the same point with no summary cost would pay.
	if free := CompactionAt(small, 38, opus, 0.25, 0); free <= 0 {
		t.Error("without a summary cost it should pay — the test is not exercising the charge")
	}
}

// Series detection must survive a transcript whose usage is missing on some
// turns; those calls cannot be priced and are skipped rather than counted at
// zero context, which would drag every average down.
func TestCallsWithoutContextAreSkipped(t *testing.T) {
	lines := []string{
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"n1","name":"Bash","input":{"command":"ls"}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"n1","content":"x"}]}}`,
	}
	for i := 1; i <= 5; i++ {
		lines = append(lines, bashCall(250000+i, "go test ./..."), bashResult(250000+i))
	}
	s, _ := ParseSession(write(t, lines...))
	got := DetectSeries(*s, DefaultRule)
	if len(got) != 1 {
		t.Fatalf("want 1 series, got %d", len(got))
	}
	if got[0].N != 5 {
		t.Errorf("n = %d, want 5 — the unpriced call must not be counted", got[0].N)
	}
	if !strings.Contains(got[0].Class, "test") {
		t.Errorf("class = %q, want test", got[0].Class)
	}
}
