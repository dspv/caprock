package main

import "testing"

func ev(turn int, tool, path, cmd string, tokens int) Event {
	return Event{Turn: turn, Tool: tool, Path: path, Command: cmd, Tokens: tokens, ContextAtCall: 300_000}
}

// A file read before a boundary and read again after it is the cost the
// estimate omits: the summary dropped it and the model went and got it back.
func TestRereadCountsWhatTheSummaryDropped(t *testing.T) {
	s := Session{ID: "s", Project: "p", CompactAt: []int{10}, Events: []Event{
		ev(1, "Read", "/a.go", "", 500),
		ev(2, "Read", "/b.go", "", 700),
		ev(11, "Read", "/a.go", "", 500), // re-read
		ev(12, "Read", "/c.go", "", 900), // new, not a re-read
		ev(25, "Bash", "", "go test ./...", 100),
	}}
	rr := AuditRereads(s)
	if len(rr) != 1 {
		t.Fatalf("got %d boundaries, want 1", len(rr))
	}
	r := rr[0]
	if r.PathsAgain != 1 {
		t.Fatalf("paths_again = %d, want only /a.go", r.PathsAgain)
	}
	if r.TokensAgain != 500 {
		t.Fatalf("tokens_again = %d, want 500", r.TokensAgain)
	}
	// Everything after the boundary, re-read or not.
	if r.TokensAfter != 1500 {
		t.Fatalf("tokens_after = %d, want 1500", r.TokensAfter)
	}
}

// A file fetched three times after a boundary is one re-read of dropped
// material plus two ordinary repeats. Charging all three to the compaction
// would inflate its cost.
func TestRereadChargesAFileOncePerBoundary(t *testing.T) {
	s := Session{ID: "s", CompactAt: []int{5}, Events: []Event{
		ev(1, "Read", "/a.go", "", 400),
		ev(6, "Read", "/a.go", "", 400),
		ev(7, "Read", "/a.go", "", 400),
		ev(8, "Read", "/a.go", "", 400),
		ev(20, "Read", "/z.go", "", 1),
	}}
	r := AuditRereads(s)[0]
	if r.TokensAgain != 400 {
		t.Fatalf("tokens_again = %d, want one charge of 400", r.TokensAgain)
	}
}

// Different commands must not collapse into one key. They did: Signature reads
// tool_input, and a flat {"command": ...} hashed every command to the same
// value, which made the whole audit read one command per session.
func TestDifferentCommandsAreDifferentKeys(t *testing.T) {
	a, okA := touched(Event{Tool: "Bash", Command: "go test ./..."})
	b, okB := touched(Event{Tool: "Bash", Command: "npm run build"})
	if !okA || !okB {
		t.Fatal("a Bash call with a command must be keyable")
	}
	if a == b {
		t.Fatalf("distinct commands share a key: %q", a)
	}
}

// A boundary with nothing after it proves nothing about compaction's cost, and
// must not be averaged in as a cheap one.
func TestBoundariesAtTheEndAreNotEvidence(t *testing.T) {
	s := Session{ID: "s", CompactAt: []int{100}, Events: []Event{
		ev(1, "Read", "/a.go", "", 400),
		ev(101, "Read", "/a.go", "", 400),
	}}
	rep := AnalyseRereads([]Session{s})
	if rep.Boundaries != 1 {
		t.Fatalf("boundaries = %d", rep.Boundaries)
	}
	if rep.Measurable != 0 {
		t.Fatalf("measurable = %d, want 0 -- only 1 turn followed the boundary", rep.Measurable)
	}
}

// The gate is about compacting EARLY. A boundary at the ceiling is the default
// firing when it has no choice; it discards little, re-reads little, and is not
// evidence that an early boundary would be cheap.
func TestEarlyBoundariesAreCountedApart(t *testing.T) {
	late := Session{ID: "late", CompactAt: []int{5}, Events: []Event{
		{Turn: 1, Tool: "Read", Path: "/a.go", Tokens: 100, ContextAtCall: 990_000},
		{Turn: 40, Tool: "Read", Path: "/a.go", Tokens: 100, ContextAtCall: 200_000},
	}}
	early := Session{ID: "early", CompactAt: []int{5}, Events: []Event{
		{Turn: 1, Tool: "Read", Path: "/b.go", Tokens: 100, ContextAtCall: 300_000},
		{Turn: 40, Tool: "Read", Path: "/b.go", Tokens: 100, ContextAtCall: 100_000},
	}}
	rep := AnalyseRereads([]Session{late, early})
	if rep.Measurable != 2 {
		t.Fatalf("measurable = %d, want 2", rep.Measurable)
	}
	if rep.EarlyBoundaries != 1 {
		t.Fatalf("early = %d, want only the 300k one", rep.EarlyBoundaries)
	}
}
