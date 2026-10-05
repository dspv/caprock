package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func TestSplitShellCountsCommitsAtStatementStartOnly(t *testing.T) {
	cases := []struct {
		cmd  string
		want int
	}{
		{`git commit -m "fix: x"`, 1},
		{`git add -A && git commit -q -m "a" && git push`, 1},
		{`cd sub; git -C ../x commit -m one; git commit --amend --no-edit`, 2},
		// A message that mentions a commit is prose, quoted or in a heredoc.
		{"git commit -m \"docs: explain\nwhy git commit is counted\"", 1},
		{"git commit -F - <<'EOF'\nfeat: x\n\ngit commit inside the body\nEOF\necho done", 1},
		{"git commit -F- <<EOF\nbody\ngit commit\nEOF", 1},
		{`echo "git commit"`, 0},
		{`grep -n "git commit" file.go`, 0},
		{`if true; then git commit -m x; fi`, 1},
		{`GIT_AUTHOR_NAME=a git commit -m x`, 1},
		{`git log --grep commit`, 0},
		{`(cd x && git commit -m y)`, 1},
		{`out=$(git commit -m z)`, 1},
	}
	for _, c := range cases {
		if got := countCommits(splitShell(c.cmd, "/r"), ""); got != c.want {
			t.Errorf("%q: %d commits, want %d", c.cmd, got, c.want)
		}
	}
	if got := countCommits(splitShell(`git commit -m x`, "/r"), "On branch main\nnothing to commit, working tree clean"); got != 0 {
		t.Errorf("nothing to commit counted %d", got)
	}
}

func TestSplitShellFollowsCd(t *testing.T) {
	st := splitShell(`cd ../web && gh pr merge 12 --squash`, filepath.FromSlash("/dev/app"))
	if len(st) != 1 || st[0].dir != filepath.Join(filepath.FromSlash("/dev/app"), "../web") {
		t.Fatalf("got %+v", st)
	}
}

func TestParseMerge(t *testing.T) {
	cases := []struct {
		cmd    string
		slug   string
		number int
	}{
		{`gh pr merge 88 --squash --delete-branch 2>&1 | tail -2`, "", 88},
		{`gh pr merge --squash --subject "feat: 12 things" 40`, "", 40},
		{`gh pr merge https://github.com/Acme/Web/pull/7 --merge`, "Acme/Web", 7},
		{`gh pr merge -R acme/api 5`, "acme/api", 5},
		{`gh pr merge --repo=github.com/acme/api 6`, "acme/api", 6},
		{`gh pr merge --squash --delete-branch`, "", 0},
		{`gh pr merge $N --squash`, "", 0},
		{`gh pr merge fix/branch --squash`, "", 0},
	}
	for _, c := range cases {
		st := splitShell(c.cmd, "/r")
		if len(st) == 0 || ghPR(st[0]) != "merge" {
			t.Fatalf("%q: not read as a merge: %+v", c.cmd, st)
		}
		m := parseMerge(st[0])
		if m.slug != c.slug || m.number != c.number {
			t.Errorf("%q: got %q #%d, want %q #%d", c.cmd, m.slug, m.number, c.slug, c.number)
		}
	}
}

func TestOpenedPRsSkipsExistingOnes(t *testing.T) {
	out := "remote:\nhttps://github.com/acme/api/pull/3\n" +
		"a pull request for branch \"x\" into branch \"main\" already exists:\nhttps://github.com/acme/api/pull/2 already exists\n" +
		"https://github.com/acme/api/pull/3"
	got := openedPRs(out)
	if len(got) != 1 || got[0] != (prRef{"acme/api", 3}) {
		t.Fatalf("got %+v", got)
	}
}

func TestWaitsOnCI(t *testing.T) {
	for cmd, want := range map[string]bool{
		`gh pr checks 12 --watch`:            true,
		`sleep 30; gh run watch 99`:          true,
		`./scripts/waitci.sh 12`:             true,
		`bash wait-ci.sh`:                    true,
		`echo "gh pr checks" > notes.txt`:    false,
		`gh pr view 12 --json statusCheckRo`: false,
	} {
		if got := waitsOnCI(splitShell(cmd, "/r")); got != want {
			t.Errorf("%q: %v, want %v", cmd, got, want)
		}
	}
}

func TestLineCount(t *testing.T) {
	for s, want := range map[string]int64{"": 0, "a": 1, "a\n": 1, "a\nb": 2, "a\nb\n": 2} {
		if got := lineCount(s); got != want {
			t.Errorf("%q: %d, want %d", s, got, want)
		}
	}
}

// weekFixture writes one week of events in a non-UTC zone, so day bucketing
// is tested against local midnights rather than UTC ones.
type weekFixture struct {
	t   *testing.T
	s   *Store
	loc *time.Location
	n   int
}

func (f *weekFixture) session(id, agent, cwd string) {
	f.t.Helper()
	if err := UpsertSession(context.Background(), f.s.DB(), id, SessionPatch{Agent: agent, Cwd: cwd, StartedAt: 1, LastEventAt: 1}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *weekFixture) put(ev event.Event) {
	f.t.Helper()
	f.n++
	if ev.Key == "" {
		ev.Key = "k" + itoa(f.n)
	}
	if _, err := InsertEvent(context.Background(), f.s.DB(), &ev); err != nil {
		f.t.Fatal(err)
	}
}

func (f *weekFixture) turn(sess, agentID string, at time.Time, cost float64, cacheRead int64) {
	c := cost
	f.put(event.Event{SessionID: sess, AgentID: agentID, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Ts: at, Model: "claude-opus-5", CostUSD: &c, Tokens: &event.TokenDelta{In: 10, Out: 10, CacheRead: cacheRead}})
}

func (f *weekFixture) post(tool string, at time.Time, payload map[string]any) {
	b, _ := json.Marshal(payload)
	f.put(event.Event{SessionID: "main", Source: event.SourceHook, Kind: event.KindToolPost, Tool: tool, Ts: at, Payload: b})
}

func bash(cwd, cmd, stdout string) map[string]any {
	return map[string]any{
		"hook_event_name": "PostToolUse", "cwd": cwd, "duration_ms": 1000,
		"tool_input":    map[string]any{"command": cmd},
		"tool_response": map[string]any{"stdout": stdout, "stderr": "", "interrupted": false},
	}
}

func TestWeekStatsCountsWhatTheAgentsShipped(t *testing.T) {
	ctx := context.Background()
	loc := time.FixedZone("UTC+3", 3*3600)
	f := &weekFixture{t: t, s: openTest(t), loc: loc}
	from := time.Date(2026, 9, 27, 0, 0, 0, 0, loc)
	day := func(d, h int) time.Time { return from.AddDate(0, 0, d).Add(time.Duration(h) * time.Hour) }
	repo := t.TempDir()
	tmp := t.TempDir()

	f.session("main", "claude", repo)
	f.session("cdx", "codex", repo)
	f.session("old", "claude", repo)

	f.turn("main", "", day(0, 1), 2.0, 1000)
	f.turn("main", "", day(2, 1), 3.0, 1000)
	f.turn("main", "sub-1", day(2, 2), 1.0, 1000)
	f.turn("main", "sub-2", day(2, 3), 0.5, 0)
	f.turn("cdx", "", day(4, 1), 0.5, 0)
	// Outside the window on both sides: local midnight, not UTC midnight.
	f.turn("old", "", from.Add(-time.Minute), 100, 0)
	f.turn("old", "", from.AddDate(0, 0, 7), 100, 0)

	// Two PRs opened from the repository, one of them twice.
	f.post("Bash", day(2, 4), bash(repo, `git add -A && git commit -m "feat: a" && git push && gh pr create --fill`, "https://github.com/acme/api/pull/10"))
	f.post("Bash", day(3, 4), bash(repo, `gh pr create --fill`, "https://github.com/acme/api/pull/11"))
	f.post("Bash", day(3, 5), bash(repo, `gh pr create --fill`, "a pull request for branch \"x\" already exists:\nhttps://github.com/acme/api/pull/11"))
	// Merged by number (resolved to acme/api through the directory), by URL
	// (the same PR again: still one), and by the current-branch form whose
	// output names one PR.
	f.post("Bash", day(3, 6), bash(repo, `gh pr merge 10 --squash`, ""))
	f.post("Bash", day(3, 7), bash(repo, `gh pr merge https://github.com/acme/api/pull/10`, ""))
	f.post("Bash", day(3, 8), bash(repo, `gh pr create --fill && gh pr merge --squash`, "https://github.com/acme/api/pull/12"))
	// A merge whose target cannot be read is not counted, only reported.
	f.post("Bash", day(3, 9), bash(repo, `gh pr merge $N --squash`, ""))
	// A failed call counts for nothing.
	failed := bash(repo, `git commit -m "nope" && gh pr create`, "https://github.com/acme/api/pull/99")
	failed["hook_event_name"] = "PostToolUseFailure"
	f.post("Bash", day(3, 10), failed)
	// CI waiting is tool time.
	ci := bash(repo, `gh pr checks 10 --watch`, "")
	ci["duration_ms"] = 60_000
	f.post("Bash", day(3, 11), ci)

	// Edits: two files in the repository; scratch files do not count.
	f.post("Edit", day(3, 12), map[string]any{"hook_event_name": "PostToolUse", "tool_input": map[string]any{"file_path": filepath.Join(repo, "a.go"), "old_string": "x\ny", "new_string": "x\ny\nz"}})
	f.post("Write", day(3, 13), map[string]any{"hook_event_name": "PostToolUse", "tool_input": map[string]any{"file_path": filepath.Join(repo, "b.go"), "content": "1\n2\n3\n4\n"}})
	f.post("Write", day(3, 14), map[string]any{"hook_event_name": "PostToolUse", "tool_input": map[string]any{"file_path": filepath.Join(tmp, "scratch.txt"), "content": "1\n2\n"}})
	// A transcript-plane post keeps its input on the tool.pre.
	pre, _ := json.Marshal(map[string]any{"tool_input": map[string]any{"file_path": filepath.Join(repo, "a.go"), "old_string": "", "new_string": "w"}})
	f.put(event.Event{SessionID: "main", Source: event.SourceTranscript, Kind: event.KindToolPre, Tool: "Edit", Ts: day(3, 15), Key: "pre:tu1", Payload: pre})
	post, _ := json.Marshal(map[string]any{"is_error": false, "tool_use_id": "tu1", "tool_response": "ok"})
	f.put(event.Event{SessionID: "main", Source: event.SourceTranscript, Kind: event.KindToolPost, Tool: "Edit", Ts: day(3, 15), Key: "post:tu1", Payload: post})

	w, err := WeekStats(ctx, f.s.DB(), WeekOptions{From: from, To: from.AddDate(0, 0, 7), Loc: loc, TempDirs: []string{tmp}})
	if err != nil {
		t.Fatal(err)
	}
	if len(w.Days) != 7 || w.Days[0].Day != "2026-09-27" || w.Days[6].Day != "2026-10-03" {
		t.Fatalf("days %+v", w.Days)
	}
	if w.CostUSD != 7.0 || w.Turns != 5 {
		t.Errorf("cost %v turns %d, want 7 and 5", w.CostUSD, w.Turns)
	}
	if w.Sessions != 2 || w.ActiveDays != 4 {
		t.Errorf("sessions %d active days %d, want 2 and 4", w.Sessions, w.ActiveDays)
	}
	if w.PRsOpened != 3 {
		t.Errorf("opened %d, want 3", w.PRsOpened)
	}
	if w.Days[2].PRsOpened != 1 || w.Days[3].PRsOpened != 2 {
		t.Errorf("per day %+v", w.Days)
	}
	if w.PRsMerged != 2 || w.MergesUnresolved != 1 {
		t.Errorf("merged %d unresolved %d, want 2 and 1", w.PRsMerged, w.MergesUnresolved)
	}
	if w.Commits != 1 {
		t.Errorf("commits %d, want 1", w.Commits)
	}
	if w.FilesEdited != 2 || w.LinesAdded != 3+4+1 || w.LinesRemoved != 2 {
		t.Errorf("files %d +%d -%d, want 2 +8 -2", w.FilesEdited, w.LinesAdded, w.LinesRemoved)
	}
	if w.CIWaitMs != 60_000 {
		t.Errorf("ci wait %d", w.CIWaitMs)
	}
	var mainT, subs, codex *WeekAgent
	for i := range w.Agents {
		a := &w.Agents[i]
		switch {
		case a.Agent == "claude" && !a.Subagent:
			mainT = a
		case a.Agent == "claude" && a.Subagent:
			subs = a
		case a.Agent == "codex":
			codex = a
		}
	}
	if mainT == nil || mainT.Turns != 2 || mainT.CostUSD != 5 {
		t.Errorf("main %+v", mainT)
	}
	if subs == nil || subs.Threads != 2 || subs.CostUSD != 1.5 {
		t.Errorf("subagents %+v", subs)
	}
	if codex == nil || codex.Turns != 1 {
		t.Errorf("codex %+v", codex)
	}
	if w.Biggest == nil || w.Biggest.CostUSD != 6.5 || w.Biggest.ActiveDays != 2 || w.Biggest.Agent != "claude" {
		t.Errorf("biggest %+v", w.Biggest)
	}
	// Nothing that names a repository or a session leaves the store.
	b, _ := json.Marshal(w)
	for _, leak := range []string{repo, "main", "acme"} {
		if json.Valid(b) && contains(string(b), leak) {
			t.Errorf("week JSON carries %q: %s", leak, b)
		}
	}
}

func contains(s, sub string) bool {
	return len(sub) > 0 && len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}

func TestWeekLoopUsesTheDetectorsRule(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	from := time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC)
	f.session("s", "codex", "")
	call := func(at time.Time, tool, input, msg string) {
		f.put(event.Event{SessionID: "s", Source: event.SourceCodex, Kind: event.KindToolPre, Tool: tool, Ts: at, MsgID: msg,
			Payload: json.RawMessage(`{"tool_input":{"command":` + input + `}}`)})
	}
	poll := `"const r = await tools.write_stdin({session_id:7,chars:\"\",yield_time_ms:1000}); text(r.output)"`
	t0 := from.Add(time.Hour)
	// Six polls 20 s apart with other work between them: one episode of six.
	for i := 0; i < 6; i++ {
		call(t0.Add(time.Duration(i)*20*time.Second), "exec", poll, "")
		call(t0.Add(time.Duration(i)*20*time.Second+time.Second), "exec", `"ls"`, "")
	}
	// Eight identical subagent launches issued by ONE message: a panel, not a
	// loop.
	for i := 0; i < 8; i++ {
		call(t0.Add(2*time.Hour+time.Duration(i)*time.Second), "Agent", `"review"`, "msg-panel")
	}
	// Repeated reads never count.
	for i := 0; i < 20; i++ {
		call(t0.Add(3*time.Hour+time.Duration(i)*time.Second), "Read", `"a.go"`, "")
	}
	// Four repeats are below K.
	for i := 0; i < 4; i++ {
		call(t0.Add(4*time.Hour+time.Duration(i)*time.Second), "Bash", `"make test"`, "")
	}

	w, err := WeekStats(ctx, f.s.DB(), WeekOptions{From: from, To: from.AddDate(0, 0, 7), Loc: time.UTC, LoopK: 5, LoopWindow: 3 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if w.Loop == nil {
		t.Fatal("no loop found")
	}
	if w.Loop.Calls != 6 || w.Loop.Kind != "poll" || w.Loop.Agent != "codex" {
		t.Fatalf("loop %+v", w.Loop)
	}
	if got := w.Loop.LastMs - w.Loop.FirstMs; got != 100_000 {
		t.Fatalf("loop span %d ms", got)
	}
}

func TestWeekStatsEmptyWindow(t *testing.T) {
	s := openTest(t)
	from := time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC)
	w, err := WeekStats(context.Background(), s.DB(), WeekOptions{From: from, To: from.AddDate(0, 0, 7), Loc: time.UTC})
	if err != nil {
		t.Fatal(err)
	}
	if len(w.Days) != 7 || w.Loop != nil || w.Biggest != nil || w.Agents == nil || w.Models == nil {
		t.Fatalf("empty week %+v", w)
	}
}

// The loop scan reads slices of the window side by side. An episode that
// straddles a slice boundary is still one episode, as in a single pass.
func TestWeekLoopAcrossScanSlices(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	from := time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC)
	f.session("s", "claude", "")
	t0 := from.Add(time.Hour)
	// Forty identical calls 20 s apart: every slice holds some of them.
	for i := 0; i < 40; i++ {
		f.put(event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash",
			Ts: t0.Add(time.Duration(i) * 20 * time.Second), Payload: json.RawMessage(`{"tool_input":{"command":"gh pr checks 12"}}`)})
	}
	spans, err := weekSpans(ctx, f.s.DB(), "tool.pre", from.UnixMilli(), from.AddDate(0, 0, 7).UnixMilli(), loopScanWorkers)
	if err != nil {
		t.Fatal(err)
	}
	if len(spans) < 2 {
		t.Fatalf("spans %v: the window was not cut, so this test proves nothing", spans)
	}
	if spans[0][0] != from.UnixMilli() || spans[len(spans)-1][1] != from.AddDate(0, 0, 7).UnixMilli() {
		t.Fatalf("spans %v do not cover the window", spans)
	}
	for i := 1; i < len(spans); i++ {
		if spans[i][0] != spans[i-1][1] {
			t.Fatalf("spans %v leave a gap or overlap", spans)
		}
	}
	w, err := WeekStats(ctx, f.s.DB(), WeekOptions{From: from, To: from.AddDate(0, 0, 7), Loc: time.UTC, LoopK: 5, LoopWindow: 3 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if w.Loop == nil || w.Loop.Calls != 40 {
		t.Fatalf("loop %+v, want one episode of 40", w.Loop)
	}
}
