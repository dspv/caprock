package daemon

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/eta"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// The Queue view (GET /v1/queue, .ai/03-contracts.md § Queue): every session
// Caprock started, what it is doing, what waits in its message queue and
// roughly when each message starts and is done, and the turns finished in
// the last hours. Built per request from what is already stored; nothing is
// polled. The estimates read each project's newest finished turns once per
// estTTL, through a partial covering index (migration 0048).

const (
	// boardDoneFor is how far back the Done list reaches.
	boardDoneFor = 3 * time.Hour
	// boardDoneMax caps it.
	boardDoneMax = 30
	// boardLookback reads turn bounds this long before a cut, so a turn
	// that began earlier is whole.
	boardLookback = 24 * time.Hour
	// boardHistory is the oldest turn an estimate reads.
	boardHistory = 90 * 24 * time.Hour
	// estTTL is how long a project's turn statistics are reused: they move
	// by one turn in hundreds.
	estTTL = 2 * time.Minute
	// boardPromptRunes clips a finished turn's prompt.
	boardPromptRunes = 200
)

type estEntry struct {
	at    time.Time
	stats eta.Stats
	ok    bool
}

// estimate is a project's turn statistics, cached for estTTL.
func (q *msgQueue) estimate(ctx context.Context, dir string) (eta.Stats, bool, error) {
	now := q.now()
	q.estMu.Lock()
	e, hit := q.est[dir]
	q.estMu.Unlock()
	if hit && now.Sub(e.at) < estTTL {
		return e.stats, e.ok, nil
	}
	turns, err := store.ProjectTurns(ctx, q.d.store.DB(), dir, now.Add(-boardHistory), eta.Window)
	if err != nil {
		return eta.Stats{}, false, err
	}
	ds := make([]time.Duration, len(turns))
	for i, t := range turns {
		ds[i] = t.Duration()
	}
	st, ok := eta.New(ds)
	q.estMu.Lock()
	q.est[dir] = estEntry{at: now, stats: st, ok: ok}
	q.estMu.Unlock()
	return st, ok, nil
}

func toETA(r eta.Range) *api.ETA {
	return &api.ETA{LoMs: r.Lo.Milliseconds(), MidMs: r.Mid.Milliseconds(), HiMs: r.Hi.Milliseconds()}
}

func projectDir(s store.Session) string {
	if s.RepoRoot != "" {
		return s.RepoRoot
	}
	return s.Cwd
}

// Board is GET /v1/queue.
func (q *msgQueue) Board(ctx context.Context) (api.QueueBoard, error) {
	now := q.now()
	since := now.Add(-boardDoneFor)
	b := api.QueueBoard{Now: now.UnixMilli(), Sessions: []api.BoardSession{}, Done: []api.BoardDone{}, DoneSince: since.UnixMilli()}
	if q.sess == nil {
		return b, nil
	}
	db := q.d.store.DB()
	live := q.sess.OwnedRunning()
	sort.Strings(live)
	recent, err := store.RecentOwnedSessions(ctx, db, since)
	if err != nil {
		return b, err
	}
	ids := append([]string{}, live...)
	for _, id := range recent {
		if !contains(ids, id) {
			ids = append(ids, id)
		}
	}
	done, open, err := store.SessionTurns(ctx, db, ids, since, boardLookback)
	if err != nil {
		return b, err
	}
	rows := map[string]store.Session{}
	row := func(id string) store.Session {
		if s, ok := rows[id]; ok {
			return s
		}
		s, _ := store.GetSession(ctx, db, id) // unknown yet: an empty row
		rows[id] = s
		return s
	}
	for _, id := range live {
		a, ok := q.owned(id)
		if !ok {
			continue
		}
		bs, err := q.boardSession(ctx, a, row(id), open[id], now)
		if err != nil {
			return b, err
		}
		b.Sessions = append(b.Sessions, bs)
	}
	// Working first, then those waiting on you, then the idle; by project.
	rank := map[string]int{api.WaitingTurn: 0, api.WaitingPermission: 1, api.WaitingQuestion: 1, "": 2}
	sort.SliceStable(b.Sessions, func(i, j int) bool {
		x, y := b.Sessions[i], b.Sessions[j]
		if rank[x.Waiting] != rank[y.Waiting] {
			return rank[x.Waiting] < rank[y.Waiting]
		}
		return x.Project < y.Project
	})

	// Done: newest first.
	if len(done) > boardDoneMax {
		done = done[len(done)-boardDoneMax:]
	}
	pids := make([]int64, len(done))
	for i, t := range done {
		pids[i] = t.PromptID
	}
	texts, err := store.PromptTexts(ctx, db, pids, 0)
	if err != nil {
		return b, err
	}
	q.mu.Lock()
	sent := append([]deliveredMsg(nil), q.delivered...)
	q.mu.Unlock()
	for i := len(done) - 1; i >= 0; i-- {
		t := done[i]
		s := row(t.SessionID)
		prompt := texts[t.PromptID]
		b.Done = append(b.Done, api.BoardDone{
			SessionID: t.SessionID, Agent: agentOr(s.Agent), Title: s.Title, Project: s.Project,
			Prompt: clipRunes(prompt, boardPromptRunes), StartedAt: t.Start, EndedAt: t.End,
			Queued: wasDelivered(sent, t.SessionID, prompt), Failed: t.Failed,
		})
	}
	return b, nil
}

func (q *msgQueue) boardSession(ctx context.Context, a *agents.Agent, s store.Session, open store.Turn, now time.Time) (api.BoardSession, error) {
	kind := agentOr(a.Kind)
	bs := api.BoardSession{
		SessionID: a.SessionID, Agent: kind, Title: s.Title, Project: s.Project,
		Dir: projectDir(s), Branch: s.GitBranch, Queue: []api.BoardItem{},
	}
	if bs.Dir == "" {
		bs.Dir = a.Cwd
	}
	unlock := q.lock(a.SessionID)
	v, err := q.view(ctx, a)
	q.mu.Lock()
	typedAt := q.typed[a.SessionID]
	q.mu.Unlock()
	unlock()
	if err != nil {
		return bs, err
	}
	bs.Waiting = v.Waiting
	if v.Waiting != "" {
		switch {
		case open.Start > 0:
			bs.TurnStartedAt = open.Start
		case !typedAt.IsZero():
			bs.TurnStartedAt = typedAt.UnixMilli()
		}
	}
	for i, m := range v.Messages {
		bs.Queue = append(bs.Queue, api.BoardItem{QueuedMessage: m, Position: i + 1})
	}
	todos, err := store.SessionTodos(ctx, q.d.store.DB(), a.SessionID)
	if err != nil {
		return bs, err
	}
	if len(todos.Items) > 0 {
		t := &api.BoardTodo{}
		for _, it := range todos.Items {
			if it.Status == "cancelled" {
				continue
			}
			t.Total++
			if it.Status == "completed" {
				t.Done++
			}
			if it.Status == "in_progress" && t.Active == "" {
				t.Active = it.ActiveForm
				if t.Active == "" {
					t.Active = it.Text
				}
			}
		}
		bs.Todo = t
	}

	// Estimates: Claude Code only — the one agent whose turn ends Caprock
	// hears (its Stop hook).
	if kind != agents.AgentClaude {
		bs.EstimateNote = "Caprock hears when a turn ends only from Claude Code's hooks, so there is no estimate for " + kind
		return bs, nil
	}
	st, ok, err := q.estimate(ctx, bs.Dir)
	if err != nil {
		return bs, err
	}
	if !ok {
		bs.EstimateNote = fmt.Sprintf("%s finished in this project so far; an estimate needs %d", plural(st.N, "turn"), eta.MinSamples)
		return bs, nil
	}
	bs.Estimate = &api.Estimate{Turns: st.N, P25Ms: st.P25.Milliseconds(), MedianMs: st.Median.Milliseconds(), P75Ms: st.P75.Milliseconds()}
	var rem eta.Range
	switch v.Waiting {
	case api.WaitingPermission, api.WaitingQuestion:
		bs.EstimateNote = "waits for your answer in the session"
		return bs, nil
	case api.WaitingTurn:
		elapsed := time.Duration(0)
		if bs.TurnStartedAt > 0 {
			elapsed = now.Sub(time.UnixMilli(bs.TurnStartedAt))
		}
		r, ok := st.Remaining(elapsed)
		if !ok {
			bs.EstimateNote = "this turn has run longer than all but a few seen in this project"
			return bs, nil
		}
		rem = r
		bs.TurnLeft = toETA(r)
	default:
		if len(v.Messages) > 0 {
			// At its prompt with messages left: the turn ended without a
			// Stop, and nothing types them in until Send now.
			bs.EstimateNote = "the last turn ended without a reply; send the next message by hand"
			return bs, nil
		}
	}
	for i := range bs.Queue {
		start, finish := st.Queued(rem, i)
		bs.Queue[i].Start, bs.Queue[i].Finish = toETA(start), toETA(finish)
	}
	free, _ := st.Queued(rem, len(bs.Queue))
	bs.FreeIn = toETA(free)
	return bs, nil
}

func agentOr(kind string) string {
	if kind == "" {
		return agents.AgentClaude
	}
	return kind
}

func clipRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// wasDelivered: the prompt is a queued message Caprock typed into the
// session. Compared with whitespace folded, as a line break is typed as
// ESC CR and comes back from the hook as a newline.
func wasDelivered(sent []deliveredMsg, session, prompt string) bool {
	p := strings.Join(strings.Fields(prompt), " ")
	if p == "" {
		return false
	}
	for _, m := range sent {
		if m.session == session && strings.Join(strings.Fields(m.text), " ") == p {
			return true
		}
	}
	return false
}

// queuedDone hands a queued message's finished turn to the alert loop, which
// decides it under the finished switch, the cooldown and the hourly cap.
func (d *Daemon) queuedDone(ev event.Event, text string) {
	if d.queueDoneC == nil {
		return
	}
	select {
	case d.queueDoneC <- queuedDoneMsg{ev: ev, text: text}:
	default: // the loop is behind; an alert is a moment, not a record
	}
}

type queuedDoneMsg struct {
	ev   event.Event
	text string
}
