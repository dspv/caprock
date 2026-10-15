package daemon

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/board"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/hive"
	"github.com/dspv/caprock/internal/store"
)

// workSession records a session row: its agent, repository, branch and
// whether Caprock started it.
func workSession(t *testing.T, d *Daemon, id, agent, root, branch string, owned bool, lastAt time.Time) {
	t.Helper()
	boardSession(t, d, id, agent, root, owned)
	if _, err := d.store.DB().Exec(`UPDATE sessions SET git_branch = ?, last_event_at = ?, started_at = ? WHERE session_id = ?`,
		branch, lastAt.UnixMilli(), lastAt.Add(-time.Hour).UnixMilli(), id); err != nil {
		t.Fatal(err)
	}
}

func workEvent(t *testing.T, d *Daemon, ev event.Event) {
	t.Helper()
	if ev.Payload == nil {
		ev.Payload = []byte("{}")
	}
	if _, err := store.InsertEvent(context.Background(), d.store.DB(), &ev); err != nil {
		t.Fatal(err)
	}
}

func newTestWork(t *testing.T) (*workBoard, *fakeSessions, *Daemon, time.Time) {
	t.Helper()
	q, f, d := newTestQueue(t)
	// Noon today, so "today" holds the last hours whenever the test runs.
	now := startOfDay(time.Now(), time.Local).Add(12 * time.Hour)
	q.now = func() time.Time { return now }
	w := newWorkBoard(d, q)
	w.now = q.now
	w.readRepo = func(_ context.Context, root string, _ *repoGit) repoGit {
		if root != "/r" {
			return repoGit{}
		}
		ahead := 3
		return repoGit{remote: "o/r", defaultBranch: "main", unreleased: &api.WorkUnreleased{Ref: "origin/main", Items: []string{"a"}, Count: 1},
			tags: &api.WorkTags{Last: &api.WorkTag{Name: "v1", At: 1}, Gaps: 2}, ahead: &ahead}
	}
	return w, f, d, now
}

// The board across owned and hand-started sessions: each one's state, the
// running turn's range from the project's history (Claude Code only, and
// never while it waits on you), the queued messages folded together, today's
// spend, and how each is tied to a pull request.
func TestWorkBoardSessions(t *testing.T) {
	w, f, d, now := newTestWork(t)
	ctx := context.Background()
	db := d.store.DB()

	// History: six finished turns of 60…360 s in /r, in an ended session.
	workSession(t, d, "hist", "claude", "/r", "main", false, now.Add(-9*time.Hour))
	at := now.Add(-10 * time.Hour)
	for i := 1; i <= 6; i++ {
		boundAt(t, d, "hist", event.KindTurnUser, at, "")
		at = at.Add(time.Duration(i*60) * time.Second)
		boundAt(t, d, "hist", event.KindAgentStop, at, "")
		at = at.Add(time.Minute)
	}
	if _, err := db.Exec(`UPDATE sessions SET status = 'ended' WHERE session_id = 'hist'`); err != nil {
		t.Fatal(err)
	}

	// Caprock's own Claude Code session, 30 s into a turn, two messages queued.
	f.owned["own"] = agents.AgentClaude
	workSession(t, d, "own", "claude", "/r", "feat/a", true, now)
	boundAt(t, d, "own", event.KindTurnUser, now.Add(-30*time.Second), `{"prompt":"go"}`)
	for _, m := range []string{"second", strings.Repeat("é", 250)} {
		if _, err := store.AddQueued(ctx, db, "own", m, now); err != nil {
			t.Fatal(err)
		}
	}
	// One started by hand, a minute into a turn, on the default branch.
	workSession(t, d, "hand", "claude", "/r", "main", false, now)
	boundAt(t, d, "hand", event.KindTurnUser, now.Add(-time.Minute), "")
	for i, c := range []float64{1.5, 0.5} {
		usd := c
		workEvent(t, d, event.Event{SessionID: "hand", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: now.Add(-time.Duration(i+2) * time.Minute), CostUSD: &usd, Key: "c" + string(rune('0'+i))})
	}
	yesterday := 7.0
	workEvent(t, d, event.Event{SessionID: "hand", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: now.Add(-13 * time.Hour), CostUSD: &yesterday, Key: "y"})
	// Hand-started, its permission dialog on screen; it recorded a PR.
	workSession(t, d, "perm", "claude", "/r", "feat/p", false, now)
	boundAt(t, d, "perm", event.KindTurnUser, now.Add(-2*time.Minute), "")
	workEvent(t, d, event.Event{SessionID: "perm", Source: event.SourceHook, Kind: event.KindPermissionPrompt, Tool: "Bash", Ts: now.Add(-time.Minute)})
	if err := store.RecordPR(ctx, db, store.PRAction{SessionID: "perm", URL: "https://github.com/o/r/pull/9", Number: 9, Title: "p", Action: "created", Ts: now.Add(-time.Hour).UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	// Hand-started, asking a question.
	workSession(t, d, "ask", "claude", "/r", "", false, now)
	boundAt(t, d, "ask", event.KindTurnUser, now.Add(-2*time.Minute), "")
	workEvent(t, d, event.Event{SessionID: "ask", Source: event.SourceHook, Kind: event.KindPermissionPrompt, Tool: "AskUserQuestion", Ts: now.Add(-time.Minute)})
	// Its turn over (only its Stop is recorded, so the history stays six
	// turns), a subagent still at work.
	workSession(t, d, "bg", "claude", "/r", "feat/b", false, now)
	boundAt(t, d, "bg", event.KindAgentStop, now.Add(-4*time.Minute), "")
	workEvent(t, d, event.Event{SessionID: "bg", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Read", AgentID: "sub1", Ts: now.Add(-time.Minute)})
	// Codex, started by Caprock, busy.
	f.owned["cx"] = agents.AgentCodex
	workSession(t, d, "cx", "codex", "/q", "feat/c", true, now)
	workEvent(t, d, event.Event{SessionID: "cx", Source: event.SourceTranscript, Kind: event.KindToolPre, Tool: "exec_command", Ts: now.Add(-10 * time.Second)})
	// A shell is not a session on the board.
	workSession(t, d, "sh", agents.KindShell, "/r", "", true, now)

	b, err := w.Work(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]api.WorkSession{}
	for _, s := range b.Sessions {
		got[s.SessionID] = s
	}
	if len(b.Sessions) != 6 || got["sh"].SessionID != "" || got["hist"].SessionID != "" {
		t.Fatalf("sessions = %+v", b.Sessions)
	}
	if b.Sessions[0].State != api.WorkPermission && b.Sessions[0].State != api.WorkQuestion {
		t.Fatalf("waiting on you is not first: %+v", b.Sessions[0])
	}

	own := got["own"]
	if own.State != api.WorkWorking || own.TurnLeft == nil || own.TurnLeft.MidMs != 180000 || !own.Owned || own.Link != api.LinkBranch {
		t.Fatalf("own = %+v", own)
	}
	if len(b.Queued) != 2 || b.Queued[0].Position != 1 || b.Queued[0].Start.MidMs != 180000 || b.Queued[1].Finish.MidMs != 600000 {
		t.Fatalf("queued = %+v", b.Queued)
	}
	if r := []rune(b.Queued[1].Text); len(r) != boardPromptRunes+1 {
		t.Fatalf("queued text not clipped: %d runes", len(r))
	}

	hand := got["hand"]
	if hand.State != api.WorkWorking || hand.TurnLeft == nil || hand.TurnLeft.MidMs != 150000 || hand.Estimate == nil || hand.Estimate.Turns != 6 {
		t.Fatalf("hand = %+v (turn left %+v)", hand, hand.TurnLeft)
	}
	if hand.TurnStartedAt != now.Add(-time.Minute).UnixMilli() || hand.TodayUSD != 2 {
		t.Fatalf("hand started %d today %v", hand.TurnStartedAt, hand.TodayUSD)
	}
	if hand.OnDefault == nil || !*hand.OnDefault || hand.Link != api.LinkNone || !strings.Contains(hand.LinkNote, "default branch") {
		t.Fatalf("hand link = %v %q (on default %v)", hand.Link, hand.LinkNote, hand.OnDefault)
	}

	for id, state := range map[string]string{"perm": api.WorkPermission, "ask": api.WorkQuestion} {
		s := got[id]
		if s.State != state || s.TurnLeft != nil || s.Estimate == nil || s.EstimateNote != "waits for your answer in the session" {
			t.Fatalf("%s = %+v", id, s)
		}
	}
	perm := got["perm"]
	if perm.Link != api.LinkRecorded || len(perm.PRs) != 1 || perm.PRs[0].Number != 9 {
		t.Fatalf("perm link = %v %+v", perm.Link, perm.PRs)
	}
	if got["ask"].Link != api.LinkNone || got["ask"].LinkNote == "" {
		t.Fatalf("ask link = %+v", got["ask"])
	}
	if bg := got["bg"]; bg.State != api.WorkBackground || bg.TurnLeft != nil {
		t.Fatalf("bg = %+v", bg)
	}
	cx := got["cx"]
	if cx.State != api.WorkWorking || cx.Estimate != nil || !strings.Contains(cx.EstimateNote, "codex") {
		t.Fatalf("cx = %+v", cx)
	}
	// /q's default branch is not known: the branch is not taken for a link.
	if cx.OnDefault != nil || cx.Link != api.LinkNone {
		t.Fatalf("cx link = %v %+v", cx.Link, cx.OnDefault)
	}

	tot := b.Totals
	if tot.Live != 6 || tot.Working != 3 || tot.WaitingYou != 2 || tot.TodayUSD != 2 || tot.MachineTodayUSD != 2 {
		t.Fatalf("totals = %+v", tot)
	}
	if b.Hive != "off" || b.Tasks != nil {
		t.Fatalf("runner off: hive %q tasks %+v", b.Hive, b.Tasks)
	}
	if len(b.Repos) != 2 || b.Repos[0].Root != "/r" || b.Repos[0].Live != 5 || b.Repos[0].Remote != "o/r" || *b.Repos[0].AheadOfTag != 3 || b.Repos[1].Root != "/q" || b.Repos[1].Unreleased != nil {
		t.Fatalf("repos = %+v", b.Repos)
	}
}

// A repository's git reads are reused for a minute, then read again with
// the last read handed back.
func TestWorkBoardRepoReadsAreKept(t *testing.T) {
	w, _, d, now := newTestWork(t)
	workSession(t, d, "s", "claude", "/r", "main", false, now)
	reads, hadPrev := 0, false
	w.readRepo = func(_ context.Context, _ string, prev *repoGit) repoGit {
		reads++
		hadPrev = prev != nil
		return repoGit{defaultBranch: "main", sha: "abc"}
	}
	for i := 0; i < 3; i++ {
		if _, err := w.Work(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if reads != 1 || hadPrev {
		t.Fatalf("reads = %d (prev %v), want one", reads, hadPrev)
	}
	later := now.Add(workGitTTL + time.Second)
	w.now = func() time.Time { return later }
	if _, err := w.Work(context.Background()); err != nil {
		t.Fatal(err)
	}
	if reads != 2 || !hadPrev {
		t.Fatalf("after a minute: reads = %d (prev %v)", reads, hadPrev)
	}
}

// With the task runner on, its tasks are the planned column: those not
// finished, and those finished within a day; each with its worker's branch
// and the session working on it.
func TestWorkBoardTasks(t *testing.T) {
	w, _, d, now := newTestWork(t)
	ctx := context.Background()
	db := d.store.DB()
	h, err := hive.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	d.board = board.New(h, d.store, d.bus, d.log)
	for _, tr := range []store.TaskRow{
		{ID: "t1", Title: "plan", Status: hive.StatusInbox, BudgetUSD: 5},
		{ID: "t2", Title: "doing", Status: hive.StatusInProgress, Assignee: "w1", BudgetUSD: 10, CostUSD: 2.5},
		{ID: "t3", Title: "old", Status: hive.StatusDone},
	} {
		if err := store.UpsertTask(ctx, db, tr); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`UPDATE tasks SET updated_at = ? WHERE id = 't3'`, now.Add(-48*time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := store.OpenAssignment(ctx, db, "t2", "s-w1", now.Add(-time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	b, err := w.Work(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if b.Hive != "on" || len(b.Tasks) != 2 {
		t.Fatalf("hive %q tasks %+v", b.Hive, b.Tasks)
	}
	t2 := b.Tasks[1]
	if t2.ID != "t2" || t2.Branch != "caprock/w1" || t2.SessionID != "s-w1" || t2.SpentUSD != 2.5 || t2.BudgetUSD != 10 {
		t.Fatalf("t2 = %+v", t2)
	}
	if b.Tasks[0].Branch != "" || b.Tasks[0].SessionID != "" {
		t.Fatalf("t1 = %+v", b.Tasks[0])
	}
}

// A session's task list is kept while it records nothing new, and read again
// as soon as its newest event moves.
func TestTodoKeptUntilTheSessionMoves(t *testing.T) {
	q, _, d := newTestQueue(t)
	ctx := context.Background()
	now := time.Now()
	q.now = func() time.Time { return now }
	write := func(key, todos string) {
		t.Helper()
		p := []byte(`{"tool_name":"TodoWrite","tool_use_id":"` + key + `","tool_input":{"todos":` + todos + `}}`)
		workEvent(t, d, event.Event{SessionID: "s", Source: event.SourceTranscript, Kind: event.KindToolPre, Tool: "TodoWrite", Ts: now, Payload: p, Key: key})
	}
	write("u1", `[{"content":"one","status":"in_progress"}]`)
	first, err := q.todo(ctx, "s", 100)
	if err != nil || first == nil || first.Total != 1 {
		t.Fatalf("first = %+v err %v", first, err)
	}
	write("u2", `[{"content":"one","status":"completed"},{"content":"two","status":"pending"}]`)
	if same, _ := q.todo(ctx, "s", 100); same.Total != 1 {
		t.Fatalf("read again with nothing moved: %+v", same)
	}
	if moved, _ := q.todo(ctx, "s", 200); moved.Total != 2 || moved.Done != 1 {
		t.Fatalf("after the session moved: %+v", moved)
	}
}
