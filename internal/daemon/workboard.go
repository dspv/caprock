package daemon

import (
	"context"
	"fmt"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/eta"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/gitremote"
	"github.com/dspv/caprock/internal/hive"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/relplan"
	"github.com/dspv/caprock/internal/store"
)

// The Work board (GET /v1/work, ADR-064, .ai/03-contracts.md § Work): every
// live session on the machine with its state, its running turn's estimate,
// its own task list, its cost today and the pull requests it recorded; the
// task runner's tasks and the queued messages (what is planned); and the
// repositories worked in, with what their CHANGELOG has not released yet and
// how their tags are spaced. Built per request from what is already stored
// and from local git; nothing is written, nothing is polled, GitHub is never
// asked and git never fetches. The screen asks again on live frames.

const (
	// workRepoMax caps the repositories listed.
	workRepoMax = 8
	// workRecentFor is how far back a repository counts as recent.
	workRecentFor = 24 * time.Hour
	// workGitTTL is how long a repository's git reads are reused.
	workGitTTL = 60 * time.Second
	// workGitParallel is how many repositories are read at once.
	workGitParallel = 4
	// workPRs is how many of a session's recorded pull requests are listed.
	workPRs = 4
	// workTaskKeep is how long a finished task stays on the board.
	workTaskKeep = 24 * time.Hour
	// workSessionMax caps the live sessions read.
	workSessionMax = 200
	// workStateScan is how many main-thread events a session's state is
	// read from when its hooks cannot say.
	workStateScan = 30
)

// repoGit is what local git says about one repository.
type repoGit struct {
	remote        string
	defaultBranch string
	sha           string
	unreleased    *api.WorkUnreleased
	tags          *api.WorkTags
	ahead         *int
}

type repoGitEntry struct {
	at  time.Time
	git repoGit
}

// workBoard assembles the Work board.
type workBoard struct {
	d   *Daemon
	q   *msgQueue
	now func() time.Time
	// readRepo reads one repository's git state; prev is the last read, or
	// nil. Replaced in tests.
	readRepo func(ctx context.Context, root string, prev *repoGit) repoGit

	mu    sync.Mutex
	repos map[string]repoGitEntry
	// events keeps each live session's newest events by generation
	// (workevents.go).
	events workEvents
}

func newWorkBoard(d *Daemon, q *msgQueue) *workBoard {
	return &workBoard{d: d, q: q, now: time.Now, readRepo: readRepoGit, repos: map[string]repoGitEntry{}}
}

// Work is GET /v1/work.
func (w *workBoard) Work(ctx context.Context) (api.Work, error) {
	now := w.now()
	day := startOfDay(now, w.d.location())
	out := api.Work{Now: now.UnixMilli(), DayStart: day.UnixMilli(), Sessions: []api.WorkSession{}, Queued: []api.WorkQueued{}, Repos: []api.WorkRepo{}, Hive: "off"}
	db := w.d.store.DB()
	w.events.sweep()

	all, err := store.ListSessions(ctx, db, true, workSessionMax)
	if err != nil {
		return out, err
	}
	var live []store.Session
	for _, s := range all {
		if s.Agent == agents.KindShell || (w.q.sess != nil && w.q.sess.IsShell(s.SessionID)) {
			continue
		}
		live = append(live, s)
	}
	ids := make([]string, len(live))
	evcs := make(map[string]*workEventsEntry, len(live))
	today := make(map[string]float64, len(live))
	for i, s := range live {
		ids[i] = s.SessionID
		evc, err := w.sessionEvents(ctx, s.SessionID)
		if err != nil {
			return out, err
		}
		evcs[s.SessionID] = evc
		usd, err := evc.readToday(day.UnixMilli(), func() (float64, error) {
			m, err := store.SpendBySessionSince(ctx, db, []string{s.SessionID}, day.UnixMilli())
			return m[s.SessionID], err
		})
		if err != nil {
			return out, err
		}
		if usd > 0 {
			today[s.SessionID] = usd
		}
	}
	if out.Totals.MachineTodayUSD, err = store.SpendSince(ctx, db, day.UnixMilli()); err != nil {
		return out, err
	}
	_, open, err := store.SessionTurns(ctx, db, ids, now, boardLookback)
	if err != nil {
		return out, err
	}

	// The repositories: those of live sessions first, then those worked in
	// lately; their git reads also say which branch is the default.
	repos, err := w.repoList(ctx, live, now)
	if err != nil {
		return out, err
	}
	gits := w.readRepos(ctx, repos, now)
	defaults := map[string]string{}
	for i := range repos {
		g := gits[i]
		repos[i].Remote = g.remote
		repos[i].Unreleased, repos[i].Tags, repos[i].AheadOfTag = g.unreleased, g.tags, g.ahead
		if g.defaultBranch != "" {
			defaults[repos[i].Root] = g.defaultBranch
		}
	}
	out.Repos = repos

	for _, s := range live {
		ws, queued, err := w.session(ctx, s, evcs[s.SessionID], open[s.SessionID], now)
		if err != nil {
			return out, err
		}
		ws.TodayUSD = today[s.SessionID]
		if def, ok := defaults[s.RepoRoot]; ok && ws.Branch != "" {
			on := ws.Branch == def
			ws.OnDefault = &on
		}
		ws.Link, ws.LinkNote = linkOf(ws)
		out.Sessions = append(out.Sessions, ws)
		out.Queued = append(out.Queued, queued...)
		out.Totals.TodayUSD += ws.TodayUSD
		switch ws.State {
		case api.WorkWorking:
			out.Totals.Working++
		case api.WorkPermission, api.WorkQuestion:
			out.Totals.WaitingYou++
		}
	}
	out.Totals.Live = len(out.Sessions)
	// Waiting on you first: nothing moves until you answer. Then working,
	// then subagents in the background, then those at their prompt.
	rank := map[string]int{api.WorkPermission: 0, api.WorkQuestion: 0, api.WorkWorking: 1, api.WorkBackground: 2, api.WorkAtPrompt: 3}
	sort.SliceStable(out.Sessions, func(i, j int) bool {
		x, y := out.Sessions[i], out.Sessions[j]
		if rank[x.State] != rank[y.State] {
			return rank[x.State] < rank[y.State]
		}
		if x.Project != y.Project {
			return x.Project < y.Project
		}
		return x.StartedAt < y.StartedAt
	})

	if b, _ := w.d.hiveState(); b != nil {
		out.Hive = "on"
		if out.Tasks, err = workTasks(ctx, b.Store.DB(), now); err != nil {
			return out, err
		}
	}
	return out, nil
}

// session is one live session's card, and its queued messages.
func (w *workBoard) session(ctx context.Context, s store.Session, evc *workEventsEntry, open store.Turn, now time.Time) (api.WorkSession, []api.WorkQueued, error) {
	db := w.d.store.DB()
	kind := agentOr(s.Agent)
	ws := api.WorkSession{
		SessionID: s.SessionID, Agent: kind, Owned: s.Owned, Model: s.Model, ModelDisplay: w.modelDisplay(s.Model),
		Subscription: s.Subscription, Name: s.Name, Project: s.Project, RepoRoot: s.RepoRoot, Worktree: s.Worktree,
		Branch: s.GitBranch, StartedAt: s.StartedAt, WorkedAt: s.WorkedAt, PRs: []api.WorkPR{},
	}
	ws.Description, ws.DescriptionSource = api.DescribeWithSource(ctx, db, s)
	st, err := store.GetStats(ctx, db, s.SessionID)
	if err != nil {
		return ws, nil, err
	}
	ws.CostUSD = st.CostUSD
	prs, err := store.SessionPRs(ctx, db, s.SessionID)
	if err != nil {
		return ws, nil, err
	}
	for i, p := range prs {
		if i == workPRs {
			break
		}
		ws.PRs = append(ws.PRs, api.WorkPR{Number: p.Number, URL: p.URL, Title: p.Title, OpenedAt: p.OpenedAt, MergedAt: p.MergedAt, ClosedAt: p.ClosedAt})
	}

	var queued []api.WorkQueued
	a, owned := (*agents.Agent)(nil), false
	if s.Owned {
		a, owned = w.q.owned(s.SessionID)
	}
	waiting, hooked := "", false
	if owned && kind == agents.AgentClaude {
		// Caprock's own Claude Code session: the Queue view's card, as is.
		bs, err := w.q.boardSession(ctx, a, s, open, now)
		if err != nil {
			return ws, nil, err
		}
		waiting, hooked = bs.Waiting, true
		ws.TurnStartedAt, ws.TurnLeft, ws.Estimate, ws.EstimateNote, ws.Todo = bs.TurnStartedAt, bs.TurnLeft, bs.Estimate, bs.EstimateNote, bs.Todo
		for _, it := range bs.Queue {
			queued = append(queued, api.WorkQueued{SessionID: s.SessionID, Position: it.Position, Text: clipRunes(it.Text, boardPromptRunes), Start: it.Start, Finish: it.Finish})
		}
	} else {
		if ws.Todo, err = evc.readTodo(func() (*api.BoardTodo, error) { return todoOf(ctx, db, s.SessionID) }); err != nil {
			return ws, nil, err
		}
		if owned {
			// Another agent Caprock started may still hold queued messages
			// (typed at once, as it says no turn end).
			v, err := w.q.View(ctx, s.SessionID)
			if err != nil {
				return ws, nil, err
			}
			for i, m := range v.Messages {
				queued = append(queued, api.WorkQueued{SessionID: s.SessionID, Position: i + 1, Text: clipRunes(m.Text, boardPromptRunes)})
			}
		}
		if kind == agents.AgentClaude {
			evs, err := evc.read(&evc.turns, func() ([]event.Event, error) {
				return store.LastEventsFiltered(ctx, db, s.SessionID, queueTurnScan, store.EventFilter{MainOnly: true, Kinds: turnKinds})
			})
			if err != nil {
				return ws, nil, err
			}
			waiting, hooked = handWaiting(evs)
		}
	}

	switch {
	case hooked:
		ws.State = stateOf(waiting)
	default:
		if ws.State, err = w.narratedState(ctx, evc, s.SessionID, now); err != nil {
			return ws, nil, err
		}
	}
	if ws.State == api.WorkAtPrompt {
		n, err := store.LiveSubagents(ctx, db, s.SessionID, now.Add(-store.LiveSubagentWindow).UnixMilli())
		if err != nil {
			return ws, nil, err
		}
		if n > 0 {
			ws.State = api.WorkBackground
		}
	}
	if ws.State != api.WorkWorking {
		ws.TurnLeft = nil
	}
	if owned && kind == agents.AgentClaude {
		return ws, queued, nil
	}
	if ws.State == api.WorkWorking && open.Start > 0 {
		ws.TurnStartedAt = open.Start
	}
	if err := w.handEstimate(ctx, &ws, kind, now); err != nil {
		return ws, nil, err
	}
	return ws, queued, nil
}

// handEstimate fills the estimate of a session the Queue view does not hold:
// one started by hand, or another agent's. The same rule as the Queue's
// (RISK-08): Claude Code only, the project's newest finished turns, a range
// only for a running turn and never while it waits on you.
func (w *workBoard) handEstimate(ctx context.Context, ws *api.WorkSession, kind string, now time.Time) error {
	if kind != agents.AgentClaude {
		ws.EstimateNote = "Caprock hears when a turn ends only from Claude Code's hooks, so there is no estimate for " + kind
		return nil
	}
	dir := ws.RepoRoot
	if dir == "" {
		s, _ := store.GetSession(ctx, w.d.store.DB(), ws.SessionID)
		dir = s.Cwd
	}
	st, ok, err := w.q.estimate(ctx, dir)
	if err != nil {
		return err
	}
	if !ok {
		ws.EstimateNote = fmt.Sprintf("%s finished in this project so far; an estimate needs %d", plural(st.N, "turn"), eta.MinSamples)
		return nil
	}
	ws.Estimate = &api.Estimate{Turns: st.N, P25Ms: st.P25.Milliseconds(), MedianMs: st.Median.Milliseconds(), P75Ms: st.P75.Milliseconds()}
	switch ws.State {
	case api.WorkPermission, api.WorkQuestion:
		ws.EstimateNote = "waits for your answer in the session"
	case api.WorkWorking:
		elapsed := time.Duration(0)
		if ws.TurnStartedAt > 0 {
			elapsed = now.Sub(time.UnixMilli(ws.TurnStartedAt))
		}
		r, ok := st.Remaining(elapsed)
		if !ok {
			ws.EstimateNote = "this turn has run longer than all but a few seen in this project"
			return nil
		}
		ws.TurnLeft = toETA(r)
	}
	return nil
}

// handWaiting is turnWaiting for a session Caprock did not start: there is
// no manager holding its live permission dialog, so the newest hook event
// being a permission prompt means the dialog is still on its screen.
func handWaiting(evs []event.Event) (string, bool) {
	for i := len(evs) - 1; i >= 0; i-- {
		e := evs[i]
		if e.Source != event.SourceHook {
			continue
		}
		if e.Kind == event.KindPermissionPrompt && e.Tool != "AskUserQuestion" {
			return api.WaitingPermission, true
		}
		break
	}
	return turnWaiting(evs)
}

// stateOf turns the queue's waiting into a board state.
func stateOf(waiting string) string {
	switch waiting {
	case api.WaitingTurn:
		return api.WorkWorking
	case api.WaitingPermission:
		return api.WorkPermission
	case api.WaitingQuestion:
		return api.WorkQuestion
	}
	return api.WorkAtPrompt
}

// narratedState is the state of a session whose hooks do not say when its
// turn ends (another agent, or Claude Code without hooks): the Now screen's
// reading of its newest main-thread events.
func (w *workBoard) narratedState(ctx context.Context, evc *workEventsEntry, id string, now time.Time) (string, error) {
	evs, err := evc.read(&evc.state, func() ([]event.Event, error) {
		return store.LastEventsFiltered(ctx, w.d.store.DB(), id, workStateScan, store.EventFilter{MainOnly: true})
	})
	if err != nil {
		return "", err
	}
	act := narrate.Summarize(evs, narrate.Options{Now: now, IdleAfter: w.d.opt.IdleAfter})
	switch act.Health {
	case narrate.HealthWorking, narrate.HealthLooping, narrate.HealthError:
		return api.WorkWorking, nil
	case narrate.HealthWaiting:
		if last := evs[len(evs)-1]; last.Kind == event.KindPermissionPrompt {
			if last.Tool == "AskUserQuestion" {
				return api.WorkQuestion, nil
			}
			return api.WorkPermission, nil
		}
	}
	return api.WorkAtPrompt, nil
}

// linkOf says how a session is tied to a pull request: the ones its own
// commands recorded, else its branch when that is not the default. Never
// guessed from a title.
func linkOf(ws api.WorkSession) (string, string) {
	switch {
	case len(ws.PRs) > 0:
		return api.LinkRecorded, ""
	case ws.Branch == "":
		return api.LinkNone, "no branch recorded for this session"
	case ws.OnDefault != nil && *ws.OnDefault:
		return api.LinkNone, "works on the default branch, which no pull request comes from"
	case ws.OnDefault == nil:
		return api.LinkNone, "the repository's default branch is not known locally, so the branch cannot be told from it"
	}
	return api.LinkBranch, ""
}

func (w *workBoard) modelDisplay(model string) string {
	if w.d.table == nil || model == "" {
		return ""
	}
	row, ok := w.d.table.Lookup(model)
	if !ok {
		return ""
	}
	return strings.TrimPrefix(row.Display, "Claude ")
}

// workTasks is the task runner's tasks: every one not finished, and those
// finished within workTaskKeep.
func workTasks(ctx context.Context, db store.Querier, now time.Time) ([]api.WorkTask, error) {
	rows, err := store.ListTasks(ctx, db)
	if err != nil {
		return nil, err
	}
	out := []api.WorkTask{}
	cut := now.Add(-workTaskKeep).UnixMilli()
	for _, t := range rows {
		if (t.Status == hive.StatusDone || t.Status == hive.StatusFailed) && t.UpdatedAt < cut {
			continue
		}
		wt := api.WorkTask{ID: t.ID, Title: t.Title, Status: t.Status, BudgetUSD: t.BudgetUSD, SpentUSD: t.CostUSD}
		if t.Assignee != "" {
			// One worktree per worker, on caprock/<worker> (internal/agents/worktree.go).
			wt.Branch = "caprock/" + t.Assignee
		}
		sess, err := store.TaskSessions(ctx, db, t.ID)
		if err != nil {
			return nil, err
		}
		for _, s := range sess {
			if s.ToTs == 0 {
				wt.SessionID = s.SessionID
				break
			}
		}
		out = append(out, wt)
	}
	return out, nil
}

// repoList is the repositories on the board: the live sessions' first (most
// live sessions first), then those worked in within workRecentFor, newest
// first; at most workRepoMax.
func (w *workBoard) repoList(ctx context.Context, live []store.Session, now time.Time) ([]api.WorkRepo, error) {
	byRoot := map[string]*api.WorkRepo{}
	var newest = map[string]int64{}
	var order []string
	for _, s := range live {
		if s.RepoRoot == "" {
			continue
		}
		r := byRoot[s.RepoRoot]
		if r == nil {
			r = &api.WorkRepo{Root: s.RepoRoot, Name: filepath.Base(s.RepoRoot)}
			byRoot[s.RepoRoot] = r
			order = append(order, s.RepoRoot)
		}
		r.Live++
		if s.LastEventAt >= newest[s.RepoRoot] {
			newest[s.RepoRoot], r.ViaSession = s.LastEventAt, s.SessionID
		}
	}
	sort.SliceStable(order, func(i, j int) bool {
		x, y := byRoot[order[i]], byRoot[order[j]]
		if x.Live != y.Live {
			return x.Live > y.Live
		}
		return newest[order[i]] > newest[order[j]]
	})
	recent, err := store.RecentRepos(ctx, w.d.store.DB(), now.Add(-workRecentFor).UnixMilli(), workRepoMax+len(order))
	if err != nil {
		return nil, err
	}
	for _, r := range recent {
		if byRoot[r.Root] != nil {
			continue
		}
		byRoot[r.Root] = &api.WorkRepo{Root: r.Root, Name: filepath.Base(r.Root), ViaSession: r.SessionID}
		order = append(order, r.Root)
	}
	if len(order) > workRepoMax {
		order = order[:workRepoMax]
	}
	out := make([]api.WorkRepo, 0, len(order))
	for _, root := range order {
		out = append(out, *byRoot[root])
	}
	return out, nil
}

// readRepos reads each repository's git state, workGitParallel at a time,
// reusing a read younger than workGitTTL.
func (w *workBoard) readRepos(ctx context.Context, repos []api.WorkRepo, now time.Time) []repoGit {
	out := make([]repoGit, len(repos))
	var wg sync.WaitGroup
	sem := make(chan struct{}, workGitParallel)
	for i, r := range repos {
		w.mu.Lock()
		e, ok := w.repos[r.Root]
		w.mu.Unlock()
		if ok && now.Sub(e.at) < workGitTTL {
			out[i] = e.git
			continue
		}
		wg.Add(1)
		go func(i int, root string, prev *repoGit) {
			defer wg.Done()
			sem <- struct{}{}
			g := w.readRepo(ctx, root, prev)
			<-sem
			out[i] = g
			w.mu.Lock()
			w.repos[root] = repoGitEntry{at: now, git: g}
			w.mu.Unlock()
		}(i, r.Root, prevOf(e, ok))
	}
	wg.Wait()
	// Forget repositories no longer on the board.
	w.mu.Lock()
	for root, e := range w.repos {
		if now.Sub(e.at) > 10*workGitTTL {
			delete(w.repos, root)
		}
	}
	w.mu.Unlock()
	return out
}

func prevOf(e repoGitEntry, ok bool) *repoGit {
	if !ok {
		return nil
	}
	g := e.git
	return &g
}

// readRepoGit reads one repository from local git alone: origin's address,
// the remote default branch as the clone knows it, what waits on that branch
// for a release — the CHANGELOG's [Unreleased] section plus any
// changes/unreleased/ fragments (reused while the branch has not moved) — the newest tags and how far the branch is past the last one.
// Anything git cannot say is left out.
func readRepoGit(ctx context.Context, root string, prev *repoGit) repoGit {
	var g repoGit
	if raw, err := relplan.OriginURL(ctx, root); err == nil {
		if web, ok := gitremote.WebURL(raw); ok {
			g.remote = ownerName(web)
		}
	}
	ref, sha, err := relplan.DefaultRef(ctx, root)
	if err != nil {
		return g
	}
	g.defaultBranch, g.sha = strings.TrimPrefix(ref, "origin/"), sha
	if prev != nil && prev.sha == sha {
		g.unreleased = prev.unreleased
	} else {
		var u relplan.Unreleased
		found := false
		if cl, ok := relplan.Changelog(ctx, root, sha); ok {
			u, found = relplan.ParseUnreleased(cl)
		}
		if frags, ok := relplan.Fragments(ctx, root, sha); ok {
			found = true
			for _, f := range frags {
				relplan.AddFragment(&u, f)
			}
		}
		if found {
			items := u.Items
			if items == nil {
				items = []string{}
			}
			g.unreleased = &api.WorkUnreleased{Ref: ref, Items: items, Count: u.Count, More: u.Count > len(items), Kinds: u.Kinds}
		}
	}
	tags, err := relplan.Tags(ctx, root)
	if err != nil || len(tags) == 0 {
		return g
	}
	t := &api.WorkTags{Last: &api.WorkTag{Name: tags[0].Name, At: tags[0].At}}
	t.GapMedianMs, t.Gaps = relplan.MedianGap(tags)
	g.tags = t
	if n, err := relplan.Ahead(ctx, root, tags[0].Name, sha); err == nil {
		g.ahead = &n
	}
	return g
}

// ownerName is "owner/name" from a repository's web address.
func ownerName(web string) string {
	u, err := url.Parse(web)
	if err != nil {
		return ""
	}
	return strings.TrimSuffix(strings.Trim(u.Path, "/"), ".git")
}
