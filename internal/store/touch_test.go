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

// TestTurnInOneDirectoryIsAttributedExactly is the core promise: a turn whose
// every touch is in one directory charges that directory its FULL cost, not a
// share of it.
func TestTurnInOneDirectoryIsAttributedExactly(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	api := filepath.Join(root, "services", "api")
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	addTurn(t, s, "s1", "m1", 1, 3)
	// Two touches, same directory, different files: still one directory.
	addTouch(t, s, "s1", "m1", 1, filepath.Join(api, "main.go"))
	addTouch(t, s, "s1", "m1", 2, filepath.Join(api, "handler.go"))
	// A second turn elsewhere, so the breakdown has two rows and survives the
	// "one directory is not a breakdown" rule.
	addTurn(t, s, "s1", "m2", 3, 1)
	addTouch(t, s, "s1", "m2", 3, filepath.Join(root, "services", "web", "app.ts"))

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
}

// TestMultiDirectoryTurnIsNotSplit is the honesty rule: a turn that spans two
// directories is attributed to NEITHER, and its cost is not divided between
// them. Splitting would be a modelled number presented as a measured one.
func TestMultiDirectoryTurnIsNotSplit(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	api := filepath.Join(root, "services", "api")
	web := filepath.Join(root, "services", "web")
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	// A clean single-directory turn, so there is something to (wrongly) merge into.
	addTurn(t, s, "s1", "m1", 1, 2)
	addTouch(t, s, "s1", "m1", 1, filepath.Join(api, "main.go"))
	// The straddling turn: one touch in each service.
	addTurn(t, s, "s1", "m2", 2, 10)
	addTouch(t, s, "s1", "m2", 2, filepath.Join(api, "main.go"))
	addTouch(t, s, "s1", "m2", 3, filepath.Join(web, "app.ts"))

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	p := onlyProject(t, sum)
	got := pathsOf(p)
	// The clean turn's directory keeps exactly its own $2 — none of the $10.
	if ps := got["/services/api"]; ps.CostUSD != 2 {
		t.Errorf("/services/api = $%v, want $2; the straddling turn's cost leaked into it (%+v)", ps.CostUSD, got)
	}
	if _, ok := got["/services/web"]; ok {
		t.Errorf("/services/web has a row, but its only turn also touched another directory (%+v)", got)
	}
	un, ok := got[UnattributedPath]
	if !ok {
		t.Fatalf("no unattributed row; the straddling turn's $10 vanished (%+v)", got)
	}
	if un.CostUSD != 10 {
		t.Errorf("unattributed = $%v, want the straddling turn's whole $10", un.CostUSD)
	}
	if !un.Unattributed {
		t.Error("the unattributed row is not flagged, so the panel would render it as a directory")
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
	addTurn(t, s, "s1", "m1", 1, 2.5)
	addTouch(t, s, "s1", "m1", 1, filepath.Join(root, "a", "f.go"))
	addTurn(t, s, "s1", "m2", 2, 4.25)
	addTouch(t, s, "s1", "m2", 2, filepath.Join(root, "b", "f.go"))
	// Straddles: unattributed.
	addTurn(t, s, "s1", "m3", 3, 1.75)
	addTouch(t, s, "s1", "m3", 3, filepath.Join(root, "a", "f.go"))
	addTouch(t, s, "s1", "m3", 4, filepath.Join(root, "b", "f.go"))
	// No touches at all: also unattributed.
	addTurn(t, s, "s1", "m4", 5, 0.5)

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

// TestTouchOutsideRepositoryIsNotCharged: a turn that edits a file in another
// checkout, or in /tmp, must not invent a directory row under THIS repository.
// The money still counts toward the repository — it was really spent there —
// so it lands unattributed.
func TestTouchOutsideRepositoryIsNotCharged(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	base := t.TempDir()
	root := newRepo(t, filepath.Join(base, "mine"))
	elsewhere := filepath.Join(base, "someone-else", "src")
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	addTurn(t, s, "s1", "m1", 1, 2)
	addTouch(t, s, "s1", "m1", 1, filepath.Join(root, "in", "f.go"))
	addTurn(t, s, "s1", "m2", 2, 5)
	addTouch(t, s, "s1", "m2", 2, filepath.Join(elsewhere, "other.go"))

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	p := onlyProject(t, sum)
	got := pathsOf(p)
	for path := range got {
		if path != UnattributedPath && path != "/in" {
			t.Errorf("breakdown invented the row %q for a path outside the repository (%+v)", path, got)
		}
	}
	if un := got[UnattributedPath]; un.CostUSD != 5 {
		t.Errorf("unattributed = $%v, want $5 — the outside touch's turn (%+v)", un.CostUSD, got)
	}
	if p.CostUSD != 7 {
		t.Errorf("repository total = $%v, want $7; spend must not be dropped just because it left the tree", p.CostUSD)
	}
}

// TestTurnWithNoTouchesIsUnattributed: a turn that only ran Bash, or only
// thought, names no directory. It must not be silently dropped (the repository
// total would shrink) nor guessed onto the session's cwd (the old, wrong
// signal).
func TestTurnWithNoTouchesIsUnattributed(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	addTurn(t, s, "s1", "m1", 1, 3)
	addTouch(t, s, "s1", "m1", 1, filepath.Join(root, "api", "f.go"))
	// A turn whose only tool is Bash — a path in the command is NOT a touch.
	addTurn(t, s, "s1", "m2", 2, 8)
	addTouchTool(t, s, "s1", "m2", 2, "Bash",
		map[string]any{"command": "go build " + filepath.Join(root, "api") + "/..."})

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := pathsOf(onlyProject(t, sum))
	if ps := got["/api"]; ps.CostUSD != 3 {
		t.Errorf("/api = $%v, want $3 — the Bash turn was charged to a directory it merely named (%+v)", ps.CostUSD, got)
	}
	if un := got[UnattributedPath]; un.CostUSD != 8 {
		t.Errorf("unattributed = $%v, want the Bash turn's $8 (%+v)", un.CostUSD, got)
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
			got, ok := AttributeDir(TouchDirs{Dirs: map[string]struct{}{dir: {}}}, root)
			if !ok {
				t.Fatalf("dirOf(%q) = %q, which did not attribute under root %q", tc.path, dir, root)
			}
			if got != tc.want {
				t.Errorf("AttributeDir = %q, want %q (dir was %q)", got, tc.want, dir)
			}
		})
	}
}

// TestWindowsAndUnixPathsDoNotSplitOneDirectory: the same directory written
// with both separators must be ONE directory, or a turn that touched it twice
// would look like it straddled two and fall into the unattributed bucket.
func TestWindowsAndUnixPathsDoNotSplitOneDirectory(t *testing.T) {
	const root = `C:/work/mono`
	dirs := map[string]struct{}{
		dirOf(`C:\work\mono\services\api\a.go`): {},
		dirOf(`C:/work/mono/services/api/b.go`): {},
	}
	if len(dirs) != 1 {
		t.Fatalf("one directory became %d: %v", len(dirs), dirs)
	}
	got, ok := AttributeDir(TouchDirs{Dirs: dirs}, root)
	if !ok || got != "/services/api" {
		t.Errorf("AttributeDir = %q,%v; want /services/api,true", got, ok)
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
	addTurn(t, s, "s1", "m1", 1, 5)
	addTouch(t, s, "s1", "m1", 1, filepath.Join(root, "a", "f.go"))
	addTurn(t, s, "s1", "m2", 2, 3)
	addTouch(t, s, "s1", "m2", 2, filepath.Join(root, "b", "f.go"))
	addTurn(t, s, "s1", "m3", 3, 2) // no touches: unattributed

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
	addTurn(t, s, "s1", "m1", 1, 10000)
	addTouch(t, s, "s1", "m1", 1, filepath.Join(root, "big", "f.go"))
	addTurn(t, s, "s1", "m2", 2, 0.01) // 0.0001% of the total
	addTouch(t, s, "s1", "m2", 2, filepath.Join(root, "tiny", "f.go"))

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

// TestUnlinkableToolCallDoesNotAttribute: a tool call captured by the hook
// plane carries no message id, so it cannot be tied to the turn that paid for
// it. Its session's turns must report unattributed rather than being charged on
// the evidence that happens to be linkable — the strict rule applied to its own
// blind spot.
func TestUnlinkableToolCallDoesNotAttribute(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	addTurn(t, s, "s1", "m1", 1, 4)
	addTouch(t, s, "s1", "m1", 1, filepath.Join(root, "a", "f.go"))
	// A hook-plane touch: same session, no message id.
	addTouchTool(t, s, "s1", "", 2, "Edit", map[string]any{"file_path": filepath.Join(root, "b", "f.go")})
	// A second session in the same repository, fully linkable, so the
	// breakdown still has two rows.
	if err := UpsertSession(ctx, s.db, "s2", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	addTurn(t, s, "s2", "m2", 3, 6)
	addTouch(t, s, "s2", "m2", 3, filepath.Join(root, "c", "f.go"))

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := pathsOf(onlyProject(t, sum))
	if _, ok := got["/a"]; ok {
		t.Errorf("/a was attributed, but its session has a touch that could not be linked to any turn (%+v)", got)
	}
	if un := got[UnattributedPath]; un.CostUSD != 4 {
		t.Errorf("unattributed = $%v, want the unlinkable session's $4 (%+v)", un.CostUSD, got)
	}
	if c := got["/c"]; c.CostUSD != 6 {
		t.Errorf("/c = $%v, want $6 — a clean session must not be spoiled by another session's blind spot", c.CostUSD)
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
