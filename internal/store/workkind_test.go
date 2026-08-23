package store

import (
	"context"
	"path/filepath"
	"testing"
)

// workOf indexes a summary's work breakdown by kind.
func workOf(sum Summary) map[WorkKind]WorkShare {
	m := map[WorkKind]WorkShare{}
	for _, w := range sum.Work {
		m[w.Kind] = w
	}
	return m
}

// TestWorkKindsSumToTheTotal is the promise the whole breakdown rests on: every
// turn's cost lands in exactly one row, so the rows add up to the range total
// exactly — the same guarantee the per-directory breakdown gives.
//
// It uses one turn of every kind, including a turn that called nothing and a
// turn whose tool is unknown to the classifier, so the sum covers every path
// through the rule rather than only the common ones.
func TestWorkKindsSumToTheTotal(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(root, "a", "f.go")
	// One turn per category, each with a distinct cost so a row landing in the
	// wrong bucket changes a number rather than merely moving a count.
	addTurn(t, s, "s1", "m1", 1, 1.00)
	addTouchTool(t, s, "s1", "m1", 2, "Edit", map[string]any{"file_path": f})
	addTurn(t, s, "s1", "m2", 3, 2.00)
	addTouchTool(t, s, "s1", "m2", 4, "Bash", map[string]any{"command": "go test ./..."})
	addTurn(t, s, "s1", "m3", 5, 4.00)
	addTouchTool(t, s, "s1", "m3", 6, "Read", map[string]any{"file_path": f})
	addTurn(t, s, "s1", "m4", 7, 8.00)
	addTouchTool(t, s, "s1", "m4", 8, "WebSearch", map[string]any{"query": "x"})
	addTurn(t, s, "s1", "m5", 9, 16.00)
	addTouchTool(t, s, "s1", "m5", 10, "mcp__apify__call-actor", map[string]any{})
	addTurn(t, s, "s1", "m6", 11, 32.00)
	addTouchTool(t, s, "s1", "m6", 12, "AskUserQuestion", map[string]any{})
	// A turn that called nothing at all.
	addTurn(t, s, "s1", "m7", 13, 64.00)

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	const want = 1 + 2 + 4 + 8 + 16 + 32 + 64
	var cost float64
	var turns int64
	for _, w := range sum.Work {
		cost += w.CostUSD
		turns += w.Turns
	}
	if cost != want {
		t.Errorf("work rows sum to $%v, want $%v (summary total $%v)", cost, float64(want), sum.CostUSD)
	}
	if cost != sum.CostUSD {
		t.Errorf("work rows sum to $%v, summary total is $%v", cost, sum.CostUSD)
	}
	if turns != 7 {
		t.Errorf("work rows cover %d turns, want all 7", turns)
	}
	// Each kind is where its cost says it should be. Powers of two make a
	// misplacement unambiguous: no combination of other rows can imitate one.
	w := workOf(sum)
	for kind, wantCost := range map[WorkKind]float64{
		WorkEdit: 1, WorkCommand: 2, WorkRead: 4, WorkWeb: 8,
		WorkMCP: 16, WorkOther: 32, WorkNone: 64,
	} {
		if got := w[kind].CostUSD; got != wantCost {
			t.Errorf("%s row is $%v, want $%v", kind, got, wantCost)
		}
	}
}

// TestTurnWithNoToolsIsCountedAsNoTool pins the one row whose label is a claim
// about absence. A turn that called nothing must land in WorkNone — not be
// dropped (the rows would stop summing), and not inherit the kind of the turn
// before it (work kind is a property of the turn, not of a stretch, which is
// what separates this from carry-forward directory attribution).
func TestTurnWithNoToolsIsCountedAsNoTool(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	// An editing turn FOLLOWED by a turn that calls nothing. If the kind were
	// carried forward the way a directory is, the second turn would read as an
	// edit and this test would fail.
	addTurn(t, s, "s1", "m1", 1, 3.00)
	addTouchTool(t, s, "s1", "m1", 2, "Edit", map[string]any{"file_path": filepath.Join(root, "a", "f.go")})
	addTurn(t, s, "s1", "m2", 3, 5.00)

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	w := workOf(sum)
	if got := w[WorkNone].CostUSD; got != 5.00 {
		t.Errorf("no-tool row is $%v, want $5 (the turn that called nothing)", got)
	}
	if got := w[WorkNone].Turns; got != 1 {
		t.Errorf("no-tool row covers %d turns, want 1", got)
	}
	if got := w[WorkEdit].CostUSD; got != 3.00 {
		t.Errorf("edit row is $%v, want $3 — the no-tool turn must not join it", got)
	}
}

// TestTurnWithEditAndReadIsCountedOnceAsAnEdit pins the precedence rule on the
// case it exists for: a turn that both edited and read a file is ONE turn and
// must be counted once, under the stronger claim.
//
// The stated rule is that writing a file wins over reading one (WorkKindRule).
// The test asserts both halves — that the whole cost is in the edit row, and
// that the read row does not exist — because a rule that counted the turn twice
// would satisfy the first assertion alone.
func TestTurnWithEditAndReadIsCountedOnceAsAnEdit(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(root, "a", "f.go")
	addTurn(t, s, "s1", "m1", 1, 7.00)
	// Read FIRST, then Edit: the winner must be decided by the rule, not by
	// which call happened to be scanned last.
	addTouchTool(t, s, "s1", "m1", 2, "Read", map[string]any{"file_path": f})
	addTouchTool(t, s, "s1", "m1", 3, "Edit", map[string]any{"file_path": f})
	// A weaker tool AFTER the edit: the winner must be the strongest claim, not
	// the last one scanned.
	addTouchTool(t, s, "s1", "m1", 4, "Bash", map[string]any{"command": "go build"})

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	w := workOf(sum)
	if got := w[WorkEdit].CostUSD; got != 7.00 {
		t.Errorf("edit row is $%v, want the turn's whole $7", got)
	}
	if got := w[WorkEdit].Turns; got != 1 {
		t.Errorf("edit row covers %d turns, want exactly 1", got)
	}
	if _, ok := w[WorkRead]; ok {
		t.Errorf("the turn was also counted as reading: %+v", w[WorkRead])
	}
	if _, ok := w[WorkCommand]; ok {
		t.Errorf("the turn was also counted as a command: %+v", w[WorkCommand])
	}
	var cost float64
	for _, r := range sum.Work {
		cost += r.CostUSD
	}
	if cost != 7.00 {
		t.Errorf("rows sum to $%v: the turn was split or double-counted", cost)
	}
}

// TestWorkBreakdownOnEmptyDatabase: an empty range must produce something sane
// rather than a divide-by-zero or a row of NaN percentages. Nothing was
// measured, so there are no rows — not seven rows of 0% that would read as a
// breakdown of nothing.
func TestWorkBreakdownOnEmptyDatabase(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Work) != 0 {
		t.Errorf("empty database produced %d work rows: %+v", len(sum.Work), sum.Work)
	}
	if sum.WorkUnlinkedCalls != 0 {
		t.Errorf("empty database reports %d unlinked calls", sum.WorkUnlinkedCalls)
	}
}

// TestWorkPercentagesAreFiniteWhenNothingCost guards the other divide-by-zero:
// turns that exist but carry no cost at all (an unpriced model, a cached-only
// turn). The rows must still be produced and their percentages must be real
// numbers, never NaN — a NaN reaches the UI as "NaN%".
func TestWorkPercentagesAreFiniteWhenNothingCost(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	addTurn(t, s, "s1", "m1", 1, 0)
	addTouchTool(t, s, "s1", "m1", 2, "Bash", map[string]any{"command": "ls"})

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Work) == 0 {
		t.Fatal("a zero-cost turn produced no work row at all")
	}
	for _, w := range sum.Work {
		if w.CostPct != w.CostPct || w.TokensPct != w.TokensPct { // NaN != NaN
			t.Errorf("%s row has NaN percentages: cost %v tokens %v", w.Kind, w.CostPct, w.TokensPct)
		}
	}
}

// TestWorkPercentagesSumTo100 pins the denominator. Each column is a share of
// the range total, so both must reach 100% — a percentage whose base the reader
// has to guess is what rule 6 exists to prevent.
func TestWorkPercentagesSumTo100(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(root, "a", "f.go")
	addTurn(t, s, "s1", "m1", 1, 3.00)
	addTouchTool(t, s, "s1", "m1", 2, "Edit", map[string]any{"file_path": f})
	addTurn(t, s, "s1", "m2", 3, 1.00)
	addTouchTool(t, s, "s1", "m2", 4, "Bash", map[string]any{"command": "ls"})
	addTurn(t, s, "s1", "m3", 5, 4.00) // no tool

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	var cost, tokens float64
	for _, w := range sum.Work {
		cost += w.CostPct
		tokens += w.TokensPct
	}
	if cost < 99.999 || cost > 100.001 {
		t.Errorf("cost percentages sum to %v%%, want 100%%", cost)
	}
	if tokens < 99.999 || tokens > 100.001 {
		t.Errorf("token percentages sum to %v%%, want 100%%", tokens)
	}
}

// TestUnlinkedToolCallsAreReported: a tool call with no message id cannot be
// attached to any turn, so its turn reports as having called no tool. That is
// indistinguishable from a turn that genuinely called nothing, which is exactly
// why the count of such calls travels with the breakdown — without it a broken
// linkage would silently inflate the "no tool" row and be published as a
// finding (rule 6).
func TestUnlinkedToolCallsAreReported(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	addTurn(t, s, "s1", "m1", 1, 2.00)
	// A hook-plane call: real work, no message id, so nothing links it.
	addTouchTool(t, s, "s1", "", 2, "Bash", map[string]any{"command": "go test"})

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if sum.WorkUnlinkedCalls != 1 {
		t.Errorf("reported %d unlinked calls, want 1", sum.WorkUnlinkedCalls)
	}
	// And the turn still lands somewhere, so the rows keep summing.
	w := workOf(sum)
	if got := w[WorkNone].CostUSD; got != 2.00 {
		t.Errorf("the unlinkable turn's $2 is not in the no-tool row (got $%v)", got)
	}
}

// TestWorkKindOfTurnPrecedence pins the classifier itself, independent of the
// database — the ordering is the product decision and must not drift silently.
func TestWorkKindOfTurnPrecedence(t *testing.T) {
	for _, tc := range []struct {
		name  string
		tools []string
		want  WorkKind
	}{
		{"nothing", nil, WorkNone},
		{"edit alone", []string{"Write"}, WorkEdit},
		{"edit beats command", []string{"Bash", "Edit"}, WorkEdit},
		{"command beats read", []string{"Read", "Bash"}, WorkCommand},
		{"read beats web", []string{"WebFetch", "Grep"}, WorkRead},
		{"web beats mcp", []string{"mcp__x__y", "WebSearch"}, WorkWeb},
		{"mcp beats other", []string{"AskUserQuestion", "mcp__x__y"}, WorkMCP},
		{"unknown tool is other", []string{"SomeFutureTool"}, WorkOther},
		{"mcp prefix is not matched mid-name", []string{"notmcp__x"}, WorkOther},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := WorkKindOfTurn(tc.tools); got != tc.want {
				t.Errorf("WorkKindOfTurn(%v) = %s, want %s", tc.tools, got, tc.want)
			}
		})
	}
}

// TestWorkKindDoesNotCrossSessions: two sessions can reuse a message id (they
// are unique per conversation, not globally), and the scan keys its per-turn
// kinds on the bare id. Clearing that map on every session change is what stops
// one session's tool calls from classifying another's turn.
func TestWorkKindDoesNotCrossSessions(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	for _, id := range []string{"s1", "s2"} {
		if err := UpsertSession(ctx, s.db, id, SessionPatch{Cwd: root}); err != nil {
			t.Fatal(err)
		}
	}
	// Same message id in both sessions. s1's turn edits; s2's turn calls
	// nothing. If the kinds leaked across the session boundary, s2's turn would
	// be reported as an edit.
	addTurn(t, s, "s1", "shared", 1, 1.00)
	addTouchTool(t, s, "s1", "shared", 2, "Edit", map[string]any{"file_path": filepath.Join(root, "f.go")})
	addTurn(t, s, "s2", "shared", 3, 9.00)

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	w := workOf(sum)
	if got := w[WorkNone].CostUSD; got != 9.00 {
		t.Errorf("no-tool row is $%v, want $9 — s2's turn inherited s1's tool calls", got)
	}
	if got := w[WorkEdit].CostUSD; got != 1.00 {
		t.Errorf("edit row is $%v, want $1", got)
	}
}

// TestWorkIndexReplacesTheNarrowerOne: migration 0014 widens the attribution
// index to carry `tool`, and SQLite cannot add a column in place — so the old
// index must be GONE, not left behind. A stale duplicate would cost write
// throughput on every ingested event for nothing, and would let a query still
// naming it appear to work while reading a plan that is no longer covering.
func TestWorkIndexReplacesTheNarrowerOne(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	var n int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_events_attr'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("the pre-0014 index idx_events_attr still exists alongside its replacement")
	}
}

// TestWorkRowsAreRankedByCost: the panel sits between the model mix and the
// project list, both ranked by cost and both labelled "by cost". A reader
// scanning the Cost screen for the largest driver must find it in the first row
// of every panel rather than having to read a fixed list to find the biggest.
func TestWorkRowsAreRankedByCost(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	// Commands cost the most, editing the least — the reverse of the precedence
	// order, so a panel still showing precedence order fails here.
	addTurn(t, s, "s1", "m1", 1, 1.00)
	addTouchTool(t, s, "s1", "m1", 2, "Edit", map[string]any{"file_path": filepath.Join(root, "f.go")})
	addTurn(t, s, "s1", "m2", 3, 9.00)
	addTouchTool(t, s, "s1", "m2", 4, "Bash", map[string]any{"command": "go test"})

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Work) < 2 {
		t.Fatalf("got %d rows, want at least 2", len(sum.Work))
	}
	if sum.Work[0].Kind != WorkCommand {
		t.Errorf("first row is %s ($%v), want the costliest row (command, $9)", sum.Work[0].Kind, sum.Work[0].CostUSD)
	}
	for i := 1; i < len(sum.Work); i++ {
		if sum.Work[i-1].CostUSD < sum.Work[i].CostUSD {
			t.Errorf("rows are not descending by cost: %s $%v before %s $%v",
				sum.Work[i-1].Kind, sum.Work[i-1].CostUSD, sum.Work[i].Kind, sum.Work[i].CostUSD)
		}
	}
}
