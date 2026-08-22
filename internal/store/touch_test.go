package store

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// addTurn inserts one assistant turn carrying cost, linked by message id.
func addTurn(t *testing.T, s *Store, sessionID, msgID string, seq int64, cost float64) {
	t.Helper()
	c := cost
	ev := &event.Event{
		SessionID: sessionID,
		Source:    event.SourceTranscript,
		Kind:      event.KindTurnAssistant,
		Model:     "claude-opus-5",
		Ts:        time.UnixMilli(1_000 + seq),
		Tokens:    &event.TokenDelta{In: 10, Out: 5},
		CostUSD:   &c,
		MsgID:     msgID,
		Key:       "msg:" + msgID,
	}
	if _, err := InsertEvent(context.Background(), s.db, ev); err != nil {
		t.Fatal(err)
	}
}

// addTouch inserts one tool call that reads a file, linked to a turn by message
// id — the shape ingest writes for a transcript tool_use block.
func addTouch(t *testing.T, s *Store, sessionID, msgID string, seq int64, filePath string) {
	t.Helper()
	addTouchTool(t, s, sessionID, msgID, seq, "Read", map[string]any{"file_path": filePath})
}

// addTouchTool is addTouch with control over the tool and its input, for the
// cases where the point IS the tool's shape.
func addTouchTool(t *testing.T, s *Store, sessionID, msgID string, seq int64, tool string, input map[string]any) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse", "session_id": sessionID,
		"tool_name": tool, "tool_input": input,
		"tool_use_id": fmt.Sprintf("toolu_%s_%d", msgID, seq),
		"message_id":  msgID, "_from": "transcript",
	})
	if err != nil {
		t.Fatal(err)
	}
	ev := &event.Event{
		SessionID: sessionID,
		Source:    event.SourceTranscript,
		Kind:      event.KindToolPre,
		Tool:      tool,
		Ts:        time.UnixMilli(1_000 + seq),
		Payload:   payload,
		MsgID:     msgID,
		Key:       fmt.Sprintf("pre:%s-%d-%s", msgID, seq, tool),
	}
	if _, err := InsertEvent(context.Background(), s.db, ev); err != nil {
		t.Fatal(err)
	}
}

// pathsOf indexes a repository's breakdown by path.
func pathsOf(p ProjectShare) map[string]PathShare {
	m := map[string]PathShare{}
	for _, ps := range p.Paths {
		m[ps.Path] = ps
	}
	return m
}

// onlyProject returns the single repository row, failing if there is not
// exactly one.
func onlyProject(t *testing.T, sum Summary) ProjectShare {
	t.Helper()
	if len(sum.Projects) != 1 {
		t.Fatalf("got %d project rows, want 1: %+v", len(sum.Projects), sum.Projects)
	}
	return sum.Projects[0]
}

// TestTurnIsChargedWholeToOneDirectory is the core promise: a turn's cost goes
// WHOLE to exactly one directory, never a share of it.
//
// The touches precede the turn they attribute, which is the real order of
// events: a turn.assistant row is written when the assistant message arrives,
// and the tool calls it makes are recorded as that message executes. So a turn
// is placed by the file Claude was working on when it produced that turn. On
// the owner's database only 4 of 15516 touches sort before a same-millisecond
// turn (measured 2026-08-22), so this ordering is what real data does.
func TestTurnIsChargedWholeToOneDirectory(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	api := filepath.Join(root, "services", "api")
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	// Two touches in one directory, then the turn they place.
	addTouch(t, s, "s1", "m0", 1, filepath.Join(api, "main.go"))
	addTouch(t, s, "s1", "m0", 2, filepath.Join(api, "handler.go"))
	addTurn(t, s, "s1", "m1", 3, 3)
	// A second directory, so the breakdown has two rows and survives the
	// "one directory is not a breakdown" rule.
	addTouch(t, s, "s1", "m1", 4, filepath.Join(root, "services", "web", "app.ts"))
	addTurn(t, s, "s1", "m2", 5, 1)

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := pathsOf(onlyProject(t, sum))
	if ps := got["/services/api"]; ps.CostUSD != 3 {
		t.Errorf("/services/api = $%v, want the turn's whole $3 (%+v)", ps.CostUSD, got)
	}
	if ps := got["/services/api"]; ps.Turns != 1 {
		t.Errorf("/services/api turns = %d, want 1 — two touches in one directory are one turn", ps.Turns)
	}
	if ps := got["/services/web"]; ps.CostUSD != 1 {
		t.Errorf("/services/web = $%v, want $1 (%+v)", ps.CostUSD, got)
	}
}

// TestTurnGoesWholeToTheLastDirectoryTouched: a turn that touched files in two
// directories is charged WHOLE to the last one, never divided between them.
// Splitting would need a model of how much of the turn each file deserved, and
// no such measurement exists (rule 6).
//
// This replaces TestMultiDirectoryTurnIsNotSplit, which asserted that such a
// turn was attributed to NEITHER directory. The no-split half of that promise
// is unchanged and still tested here; only the destination moved, because
// refusing to place the turn is what produced an 87.6% dumping ground.
func TestTurnGoesWholeToTheLastDirectoryTouched(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	api := filepath.Join(root, "services", "api")
	web := filepath.Join(root, "services", "web")
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	addTouch(t, s, "s1", "m0", 1, filepath.Join(api, "main.go"))
	addTurn(t, s, "s1", "m1", 2, 2)
	// The straddle: touches api, then web, before the turn they place. The LAST
	// touch wins, and the turn's cost is not divided between the two.
	addTouch(t, s, "s1", "m1", 3, filepath.Join(api, "main.go"))
	addTouch(t, s, "s1", "m1", 4, filepath.Join(web, "app.ts"))
	addTurn(t, s, "s1", "m2", 5, 10)

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := pathsOf(onlyProject(t, sum))
	// Whole, to one row: $10 to web, and api keeps exactly its own $2.
	if ps := got["/services/web"]; ps.CostUSD != 10 {
		t.Errorf("/services/web = $%v, want the straddling turn's whole $10 (%+v)", ps.CostUSD, got)
	}
	if ps := got["/services/api"]; ps.CostUSD != 2 {
		t.Errorf("/services/api = $%v, want $2 — the straddling turn's cost was split, not charged whole (%+v)",
			ps.CostUSD, got)
	}
}

// TestBreakdownSumsToRepositoryTotal is rule 6 as arithmetic: the parts add up
// to the whole, so the panel never states two totals for one repository. This
// is what makes refusing to split safe — the money is still all on screen.
func TestBreakdownSumsToRepositoryTotal(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	// An opening turn with no preceding touch (repository-wide), a turn placed
	// by a touch in /a, one placed by a straddle ending in /b, and one that
	// touched nothing and so carries /b forward. Every kind of row, so the sum
	// covers them all.
	addTurn(t, s, "s1", "m0", 1, 0.5)
	addTouch(t, s, "s1", "m0", 2, filepath.Join(root, "a", "f.go"))
	addTurn(t, s, "s1", "m1", 3, 2.5)
	addTouch(t, s, "s1", "m1", 4, filepath.Join(root, "a", "f.go"))
	addTouch(t, s, "s1", "m1", 5, filepath.Join(root, "b", "f.go"))
	addTurn(t, s, "s1", "m2", 6, 4.25)
	addTurn(t, s, "s1", "m3", 7, 1.75)

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	p := onlyProject(t, sum)
	var cost float64
	var tokens, turns int64
	for _, ps := range p.Paths {
		cost += ps.CostUSD
		tokens += ps.Tokens
		turns += ps.Turns
	}
	if cost != p.CostUSD {
		t.Errorf("breakdown sums to $%v, repository row says $%v", cost, p.CostUSD)
	}
	if tokens != p.Tokens {
		t.Errorf("breakdown sums to %d tokens, repository row says %d", tokens, p.Tokens)
	}
	if turns != 4 {
		t.Errorf("breakdown covers %d turns, want all 4", turns)
	}
}

// TestCarriedDirectoryOutsideRepositoryGetsItsOwnRow: a turn whose most recent
// touch was outside the repository — Claude's notes, a scratchpad, another
// checkout — must not invent a directory row under THIS repository, must not be
// folded into the repository root (which would claim work happened in the
// checkout that did not), and must not be dropped (the parts would stop
// reconciling). It gets its own labelled row.
//
// This replaces TestTouchOutsideRepositoryIsNotCharged, which asserted the same
// spend landed in the repository-wide bucket. On the owner's data this is 26%
// of `amarketer` and 29% of `caprock` (2026-08-22) — far too large to leave
// mislabelled as "no single home" when the home is known and simply elsewhere.
func TestCarriedDirectoryOutsideRepositoryGetsItsOwnRow(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	base := t.TempDir()
	root := newRepo(t, filepath.Join(base, "mine"))
	elsewhere := filepath.Join(base, "someone-else", "src")
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	addTouch(t, s, "s1", "m0", 1, filepath.Join(root, "in", "f.go"))
	addTurn(t, s, "s1", "m1", 2, 2)
	addTouch(t, s, "s1", "m1", 3, filepath.Join(elsewhere, "other.go"))
	addTurn(t, s, "s1", "m2", 4, 5)

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	p := onlyProject(t, sum)
	got := pathsOf(p)
	for path := range got {
		if path != OutsidePath && path != UnattributedPath && path != "/in" {
			t.Errorf("breakdown invented the row %q for a path outside the repository (%+v)", path, got)
		}
	}
	out, ok := got[OutsidePath]
	if !ok {
		t.Fatalf("no outside row; the outside turn's $5 has nowhere to go (%+v)", got)
	}
	if out.CostUSD != 5 {
		t.Errorf("outside = $%v, want the outside turn's whole $5 (%+v)", out.CostUSD, got)
	}
	if !out.Outside {
		t.Error("the outside row is not flagged, so the panel would render the sentinel as a directory path")
	}
	// It must be its own row, NOT merged into the repository root.
	if r, ok := got["/"]; ok && r.CostUSD != 0 {
		t.Errorf(`the outside turn was folded into the repository root "/" ($%v), `+
			`claiming work happened in the checkout that did not (%+v)`, r.CostUSD, got)
	}
	if p.CostUSD != 7 {
		t.Errorf("repository total = $%v, want $7; spend must not be dropped just because it left the tree", p.CostUSD)
	}
}

// TestCarryForwardCoversTurnsWithNoTouches is the whole point of the rule: work
// happens in stretches. A turn that only ran Bash, or only thought, is charged
// to the directory being worked on — the one its session most recently touched
// — instead of falling into a bucket.
//
// This replaces TestTurnWithNoTouchesIsUnattributed, whose expectation was the
// opposite and which is precisely what made the panel useless: Bash is half of
// all tool calls, so the old rule discarded the commands, tests and searches
// between two edits.
//
// It also still pins the sub-rule that survives unchanged: a path INSIDE a Bash
// command is not a touch and does not move the carry. Here the Bash command
// names /other, and the turn must still be charged to /api.
func TestCarryForwardCoversTurnsWithNoTouches(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	// One touch in /api, then three turns that touch no file: all three are /api.
	addTouch(t, s, "s1", "m0", 1, filepath.Join(root, "api", "f.go"))
	addTurn(t, s, "s1", "m1", 2, 3)
	addTouchTool(t, s, "s1", "m1", 3, "Bash",
		map[string]any{"command": "go build " + filepath.Join(root, "other") + "/..."})
	addTurn(t, s, "s1", "m2", 4, 8)
	addTurn(t, s, "s1", "m3", 5, 4) // pure thinking, no tools at all
	// A second directory, so the breakdown has two rows.
	addTouch(t, s, "s1", "m3", 6, filepath.Join(root, "web", "app.ts"))
	addTurn(t, s, "s1", "m4", 7, 1)

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := pathsOf(onlyProject(t, sum))
	// $3 (the edit) + $8 (the Bash turn) + $4 (the thinking turn).
	if ps := got["/api"]; ps.CostUSD != 15 {
		t.Errorf("/api = $%v, want $15 — the turns after the edit did not carry forward (%+v)", ps.CostUSD, got)
	}
	if ps := got["/api"]; ps.Turns != 3 {
		t.Errorf("/api turns = %d, want 3 (the edit plus the two that touched nothing)", ps.Turns)
	}
	// The Bash command named /other; that must not have created a row.
	if _, ok := got["/other"]; ok {
		t.Errorf("/other has a row, but it was only named inside a Bash command (%+v)", got)
	}
}

// TestCarryForwardDoesNotCrossSessions: the carry is per session. Charging one
// session's work to the directory another session happened to leave behind
// would attribute one piece of work to another's location.
func TestCarryForwardDoesNotCrossSessions(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	for _, id := range []string{"s1", "s2"} {
		if err := UpsertSession(ctx, s.db, id, SessionPatch{Cwd: root}); err != nil {
			t.Fatal(err)
		}
	}
	// s1 touches /api and ends.
	addTouch(t, s, "s1", "m0", 1, filepath.Join(root, "api", "f.go"))
	addTurn(t, s, "s1", "m1", 2, 3)
	// s2 opens with a turn that touches nothing. It must NOT inherit /api.
	addTurn(t, s, "s2", "m2", 3, 7)
	// so the breakdown has two rows
	addTouch(t, s, "s2", "m3", 4, filepath.Join(root, "web", "app.ts"))
	addTurn(t, s, "s2", "m4", 5, 1)

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := pathsOf(onlyProject(t, sum))
	if ps := got["/api"]; ps.CostUSD != 3 {
		t.Errorf("/api = $%v, want $3 — a later SESSION's turn carried into it (%+v)", ps.CostUSD, got)
	}
	if un := got[UnattributedPath]; un.CostUSD != 7 {
		t.Errorf("repository-wide = $%v, want $7 — s2's opening turn, which has no touch of its own "+
			"to carry from (%+v)", un.CostUSD, got)
	}
}

// TestTurnsBeforeFirstTouchAreNotCarriedBackward: attribution carries FORWARD
// only. A session's opening turns, before any file is touched, land in the
// repository-wide row rather than being charged to the directory the session
// later reached.
//
// Measured both ways on the owner's database (2026-08-22, all time): carrying
// backward would move $2.39 of $3426 in `amarketer` and $11.45 of $1729 in
// `caprock` — 0.1% and 0.7%, too little to justify a second rule pointing the
// opposite way.
func TestTurnsBeforeFirstTouchAreNotCarriedBackward(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	// The opening turn: no touch has happened yet anywhere in the session.
	addTurn(t, s, "s1", "m1", 1, 6)
	// Only afterwards does the session touch a file.
	addTouch(t, s, "s1", "m2", 2, filepath.Join(root, "api", "f.go"))
	addTurn(t, s, "s1", "m3", 3, 2)

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := pathsOf(onlyProject(t, sum))
	if ps := got["/api"]; ps.CostUSD != 2 {
		t.Errorf("/api = $%v, want $2 — the opening turn was carried BACKWARD into a directory "+
			"the session had not reached yet (%+v)", ps.CostUSD, got)
	}
	if un := got[UnattributedPath]; un.CostUSD != 6 {
		t.Errorf("repository-wide = $%v, want the opening turn's $6 (%+v)", un.CostUSD, got)
	}
}

// TestEmptyBucketRowsAreNotRendered: under carry-forward the repository-wide row
// is usually empty, and a row reading $0.00 beside real directories invites the
// reader to wonder what went wrong. A bucket with no spend must not be sent.
func TestEmptyBucketRowsAreNotRendered(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	for _, id := range []string{"s1", "s2"} {
		if err := UpsertSession(ctx, s.db, id, SessionPatch{Cwd: root}); err != nil {
			t.Fatal(err)
		}
	}
	// Three directories, so the breakdown survives on its real rows alone and
	// an empty bucket cannot hide behind the "fewer than two rows" rule. Every
	// turn is preceded by a touch inside the repository, so neither bucket has
	// anything to hold.
	addTouch(t, s, "s1", "m0", 1, filepath.Join(root, "api", "f.go"))
	addTurn(t, s, "s1", "m1", 2, 3)
	addTouch(t, s, "s1", "m1", 3, filepath.Join(root, "web", "app.ts"))
	addTurn(t, s, "s1", "m2", 4, 5)
	addTouch(t, s, "s1", "m2", 5, filepath.Join(root, "db", "schema.sql"))
	addTurn(t, s, "s1", "m3", 6, 2)
	// A zero-COST opening turn still carries tokens, so the bucket row exists
	// with $0.00 unless it is suppressed on cost. This is the shape that
	// actually reaches a user: an unpriced or cached-only turn.
	addTurn(t, s, "s2", "m4", 7, 0)

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := pathsOf(onlyProject(t, sum))
	if _, ok := got[UnattributedPath]; ok {
		t.Errorf("an empty repository-wide row was sent; it would render as $0.00 (%+v)", got)
	}
	if _, ok := got[OutsidePath]; ok {
		t.Errorf("an empty outside row was sent; it would render as $0.00 (%+v)", got)
	}
	if len(got) != 3 {
		t.Errorf("got %d rows, want exactly the three real directories (%+v)", len(got), got)
	}
}

// TestWindowsSeparatorsAttributeTheSame is rule 2 at the level that actually
// breaks: a session captured on Windows writes backslashes into the same
// database a Unix dashboard reads. If the touched path and the repository root
// are not normalized identically, the containment test fails and every Windows
// turn reports as unattributed.
func TestWindowsSeparatorsAttributeTheSame(t *testing.T) {
	// dirOf and the containment test are pure string work, so this runs and
	// means the same thing on every OS — which is the point: a Unix CI job must
	// be able to catch a Windows regression.
	const root = `C:/work/mono`
	for _, tc := range []struct {
		name string
		path string
		want string
	}{
		{"backslashes", `C:\work\mono\services\api\main.go`, "/services/api"},
		{"mixed", `C:\work\mono/services\web\app.ts`, "/services/web"},
		{"doubled", `C:\\work\\mono\\services\\api\\x.go`, "/services/api"},
		{"forward", `C:/work/mono/services/api/main.go`, "/services/api"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := dirOf(tc.path)
			got, _ := AttributeDir(TouchDirs{Dir: dir, HasDir: true}, root)
			if got == OutsidePath {
				t.Fatalf("dirOf(%q) = %q, which did not land inside root %q — a Windows-captured "+
					"session would report every turn as outside the repository", tc.path, dir, root)
			}
			if got != tc.want {
				t.Errorf("AttributeDir = %q, want %q (dir was %q)", got, tc.want, dir)
			}
		})
	}
}

// TestWindowsAndUnixPathsAreOneDirectory: the same directory written with both
// separators must resolve to ONE row. One database routinely holds both shapes,
// and two spellings of one directory would split its spend across two rows that
// look like different places.
func TestWindowsAndUnixPathsAreOneDirectory(t *testing.T) {
	const root = `C:/work/mono`
	back := dirOf(`C:\work\mono\services\api\a.go`)
	fwd := dirOf(`C:/work/mono/services/api/b.go`)
	if back != fwd {
		t.Fatalf("one directory became two: %q vs %q", back, fwd)
	}
	for _, dir := range []string{back, fwd} {
		got, _ := AttributeDir(TouchDirs{Dir: dir, HasDir: true}, root)
		if got != "/services/api" {
			t.Errorf("AttributeDir(%q) = %q, want /services/api", dir, got)
		}
	}
}

// TestPercentagesSumTo100AndIncludeUnattributed: the column's denominator is
// the repository total INCLUDING the unattributed bucket, so the shares add up
// and the part nobody could attribute is visible as its own number rather than
// hidden in the base.
func TestPercentagesSumTo100AndIncludeUnattributed(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	// The opening turn runs before any touch, so it is repository-wide: $2 of $10.
	addTurn(t, s, "s1", "m0", 1, 2)
	addTouch(t, s, "s1", "m0", 2, filepath.Join(root, "a", "f.go"))
	addTurn(t, s, "s1", "m1", 3, 5)
	addTouch(t, s, "s1", "m1", 4, filepath.Join(root, "b", "f.go"))
	addTurn(t, s, "s1", "m2", 5, 3)

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	p := onlyProject(t, sum)
	var cost, tokens float64
	for _, ps := range p.Paths {
		cost += ps.CostPct
		tokens += ps.TokensPct
	}
	const eps = 1e-9
	if diff := cost - 100; diff > eps || diff < -eps {
		t.Errorf("cost percentages sum to %v, want 100", cost)
	}
	if diff := tokens - 100; diff > eps || diff < -eps {
		t.Errorf("token percentages sum to %v, want 100", tokens)
	}
	got := pathsOf(p)
	// $2 of $10 — the unattributed share is stated, not absorbed.
	if un := got[UnattributedPath]; un.CostPct != 20 {
		t.Errorf("unattributed CostPct = %v, want 20", un.CostPct)
	}
	if a := got["/a"]; a.CostPct != 50 {
		t.Errorf("/a CostPct = %v, want 50 (of the repository total, not of the attributed part)", a.CostPct)
	}
}

// TestTinyShareIsNotReportedAsZeroSpend: a directory with real but tiny spend
// must carry a non-zero percentage in the payload, so the client's flooring is
// a DISPLAY choice it can render as "<0.1%" rather than a zero the server
// already baked in. A row that reads 0% next to a real dollar figure would say
// two contradictory things about the same money.
func TestTinyShareIsNotReportedAsZeroSpend(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	addTouch(t, s, "s1", "m0", 1, filepath.Join(root, "big", "f.go"))
	addTurn(t, s, "s1", "m1", 2, 10000)
	addTouch(t, s, "s1", "m1", 3, filepath.Join(root, "tiny", "f.go"))
	addTurn(t, s, "s1", "m2", 4, 0.01) // 0.0001% of the total

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := pathsOf(onlyProject(t, sum))
	tiny, ok := got["/tiny"]
	if !ok {
		t.Fatalf("no /tiny row: a directory with real spend disappeared (%+v)", got)
	}
	if tiny.CostUSD <= 0 {
		t.Errorf("/tiny CostUSD = %v, want its real spend", tiny.CostUSD)
	}
	if tiny.CostPct <= 0 {
		t.Errorf("/tiny CostPct = %v; a row with real spend must not report a zero share — "+
			"the client floors for display, the server must not pre-round it away", tiny.CostPct)
	}
}

// TestHookPlaneTouchWithNoMessageIDStillAttributes: a tool call captured by the
// hook plane carries no message id. Carry-forward does not need one — it places
// a turn by WHEN a touch happened relative to it, not by which message the
// touch belonged to — so such a session attributes normally.
//
// This replaces TestUnlinkableToolCallDoesNotAttribute, which asserted the
// opposite: under the strict rule one unlinkable call forced its entire
// session's spend into the bucket. That blind spot is simply gone, and the test
// now guards against it coming back.
func TestHookPlaneTouchWithNoMessageIDStillAttributes(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	// A hook-plane touch: no message id at all, then the turn it precedes.
	addTouchTool(t, s, "s1", "", 1, "Edit", map[string]any{"file_path": filepath.Join(root, "a", "f.go")})
	addTurn(t, s, "s1", "m1", 2, 4)
	// A second directory so the breakdown has two rows.
	addTouchTool(t, s, "s1", "", 3, "Edit", map[string]any{"file_path": filepath.Join(root, "b", "f.go")})
	addTurn(t, s, "s1", "m2", 4, 6)

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := pathsOf(onlyProject(t, sum))
	if ps := got["/a"]; ps.CostUSD != 4 {
		t.Errorf("/a = $%v, want $4 — a hook-plane touch carries no message id, but carry-forward "+
			"does not need one (%+v)", ps.CostUSD, got)
	}
	if ps := got["/b"]; ps.CostUSD != 6 {
		t.Errorf("/b = $%v, want $6 (%+v)", ps.CostUSD, got)
	}
	if _, ok := got[UnattributedPath]; ok {
		t.Errorf("a repository-wide row appeared; the missing message id must not force spend "+
			"into the bucket any more (%+v)", got)
	}
}

// TestTouchDirIgnoresPathlessAndMalformedInputs covers the shapes a real
// database actually holds: a tool with no path, a tool_input stored as a STRING
// (the hook plane does this), and a truncated payload.
func TestTouchDirIgnoresPathlessAndMalformedInputs(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload string
		want    string
	}{
		{"read", `{"tool_input":{"file_path":"/a/b/c.go"}}`, "/a/b"},
		{"notebook", `{"tool_input":{"notebook_path":"/a/b/n.ipynb"}}`, "/a/b"},
		{"bash has no path", `{"tool_input":{"command":"go build /a/b/..."}}`, ""},
		{"grep names a pattern", `{"tool_input":{"pattern":"foo","path":"/a/b"}}`, ""},
		{"tool_input is a string", `{"tool_input":"{'file_path': '/a/b/c.go'}"}`, ""},
		{"truncated", `{"tool_input":{"_truncated":"40000 bytes"}}`, ""},
		{"no tool_input", `{"tool_name":"Bash"}`, ""},
		{"empty", ``, ""},
		{"not json", `nonsense`, ""},
		{"relative path", `{"tool_input":{"file_path":"src/main.go"}}`, "src"},
		{"bare filename", `{"tool_input":{"file_path":"main.go"}}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := TouchDir([]byte(tc.payload)); got != tc.want {
				t.Errorf("TouchDir(%s) = %q, want %q", tc.payload, got, tc.want)
			}
		})
	}
}

// TestTouchMigrationAddsColumnsAndIndex guards migration 0012 the way
// TestModelMixIndexLeadsOnTs guards its index: without the columns there is
// nothing to attribute by, and without the index the attribution query falls
// back to reading the payload of every tool call on a polled endpoint.
func TestTouchMigrationAddsColumnsAndIndex(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	// The columns the linkage and the directory live in.
	cols := map[string]bool{}
	rows, err := s.db.QueryContext(ctx, `SELECT name FROM pragma_table_info('events')`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		cols[n] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	_ = rows.Close()
	for _, c := range []string{"msg_id", "touch_dir"} {
		if !cols[c] {
			t.Fatalf("events.%s is missing; per-directory attribution has nothing to read (migration 0012 did not run)", c)
		}
	}
	// The index the attribution query runs on.
	var idx string
	err = s.db.QueryRowContext(ctx,
		`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_events_touch'`).Scan(&idx)
	if err != nil {
		t.Fatalf("idx_events_touch is missing; every summary would scan tool.pre rows instead of seeking them: %v", err)
	}
	flat := strings.ReplaceAll(idx, " ", "")
	// touch_dir must be IN the index, or the query still reads the table per row.
	if !strings.Contains(flat, "touch_dir") || !strings.Contains(flat, "msg_id") {
		t.Errorf("index must carry msg_id and touch_dir to answer the attribution join, got: %s", idx)
	}
}

// TestAttributionIndexOrdersTheCarryScan guards migration 0013. Carry-forward
// reads one scan ordered by (session_id, ts, id); without an index in that
// order SQLite sorts 90271 rows in a temp B-tree, measured at ~290ms on the
// owner's database against a ~250ms budget for the entire summary. The index
// must also COVER every column the scan reads, or the plan falls back to a
// table lookup per row.
func TestAttributionIndexOrdersTheCarryScan(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	var idx string
	err := s.db.QueryRowContext(ctx,
		`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_events_attr'`).Scan(&idx)
	if err != nil {
		t.Fatalf("idx_events_attr is missing; the carry scan would sort every row of the range "+
			"in a temp B-tree (migration 0013 did not run): %v", err)
	}
	flat := strings.Join(strings.Fields(idx), "")
	// The ORDER BY prefix, in order: anything else reintroduces the sort.
	if !strings.Contains(flat, "(session_id,ts,id") {
		t.Errorf("index must lead with (session_id, ts, id) — the carry scan's ORDER BY — got: %s", idx)
	}
	// The payload the scan reads, so the plan stays covering.
	for _, c := range []string{"kind", "touch_dir", "cost_usd", "tokens_in", "tokens_out", "cache_read", "cache_write"} {
		if !strings.Contains(flat, c) {
			t.Errorf("index must carry %s so the carry scan stays covering, got: %s", c, idx)
		}
	}
	// And the query must actually be planned as a covering scan with no sort.
	var plan string
	rows, err := s.db.QueryContext(ctx, `
		EXPLAIN QUERY PLAN
		SELECT session_id, kind, COALESCE(touch_dir,''),
		       COALESCE(tokens_in,0)+COALESCE(tokens_out,0)+COALESCE(cache_read,0)+COALESCE(cache_write,0),
		       COALESCE(cost_usd,0)
		FROM events INDEXED BY idx_events_attr
		WHERE session_id IS NOT NULL AND ts >= 0
		  AND kind IN ('tool.pre','turn.assistant')
		ORDER BY session_id, ts, id`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var a, b, c int
		var detail string
		if err := rows.Scan(&a, &b, &c, &detail); err != nil {
			t.Fatal(err)
		}
		plan += detail + "\n"
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	_ = rows.Close()
	if strings.Contains(plan, "TEMP B-TREE") {
		t.Errorf("the carry scan sorts in a temp B-tree instead of reading in index order:\n%s", plan)
	}
	if !strings.Contains(plan, "COVERING INDEX idx_events_attr") {
		t.Errorf("the carry scan is not a covering read of idx_events_attr:\n%s", plan)
	}
}

// TestTouchBackfillResolvesHistoricalRows: migration 0012's Go-side backfill
// must fill touch_dir for tool calls written before the column existed, or
// every historical repository reports as entirely unattributed.
func TestTouchBackfillResolvesHistoricalRows(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	// Simulate a pre-0012 row: the payload has the path, the column does not.
	addTouch(t, s, "s1", "m1", 1, filepath.FromSlash("/repo/api/main.go"))
	if _, err := s.db.ExecContext(ctx,
		`UPDATE events SET touch_dir = NULL WHERE kind = 'tool.pre'`); err != nil {
		t.Fatal(err)
	}
	if err := s.SetMeta(ctx, metaTouchBackfilled, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.backfillTouch(ctx); err != nil {
		t.Fatal(err)
	}
	var got string
	if err := s.db.QueryRowContext(ctx,
		`SELECT COALESCE(touch_dir,'') FROM events WHERE kind='tool.pre'`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != "/repo/api" {
		t.Errorf("touch_dir = %q, want %q — a historical tool call was left unattributable", got, "/repo/api")
	}
}
