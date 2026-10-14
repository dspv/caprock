package brain

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/store"
)

// Defaults and pacing. None of these is a claim about cost: what a read
// costs is what claude reports, recorded per read and summed for the cap.
const (
	// DefaultModel is passed to claude --model unless the user picks another.
	DefaultModel = "haiku"
	// DefaultDailyTokens caps what the extraction spends in a rolling day.
	DefaultDailyTokens = 300_000
	// Interval is how often the extraction wakes; each wake reads at most
	// Batch sessions.
	Interval = 5 * time.Minute
	Batch    = 4
	// IdleAfter is how long a session must have been quiet before it is read,
	// so a read sees a finished stretch of work, not the middle of a turn.
	IdleAfter = 10 * time.Minute
	// MaxFailures failed reads of one session in a row, and it is skipped.
	MaxFailures = 4
	// retryAfter is the wait after a first failure; it doubles with each.
	retryAfter = 15 * time.Minute
	// OverheadTokens is what one read costs before any transcript: the
	// instructions and claude's own framing. Measured with Claude Code
	// 2.1.299 and Haiku on 2026-10-14: 4,318 input tokens for a one-line
	// transcript. Used only for the backfill's estimate.
	OverheadTokens = 4300
	// topicsSent is how many existing topics a read is shown to reuse.
	topicsSent = 60
)

// Engine runs the extraction in the background. Every field but the
// unexported ones is set before Start.
type Engine struct {
	Store *store.Store
	Bus   *bus.Bus
	Log   *slog.Logger
	Now   func() time.Time
	// Config is the extraction's settings, read on every wake.
	Config func() config.BrainConfig
	// ClaudeFound reports whether a claude binary is installed.
	ClaudeFound func() bool
	Runner      Runner

	mu        sync.Mutex
	running   bool
	lastWake  time.Time
	lastError string
	kick      chan struct{}
}

func (e *Engine) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e *Engine) log() *slog.Logger {
	if e.Log != nil {
		return e.Log
	}
	return slog.Default()
}

// Enabled reports whether the extraction may run now: a yes from the user.
// No licence is needed (owner decision, 2026-10-14).
func (e *Engine) Enabled() bool {
	c := e.Config()
	return c.Auto != nil && *c.Auto
}

// Start runs the extraction until ctx ends: a first wake a minute after
// start, then every Interval, and at once after Kick.
func (e *Engine) Start(ctx context.Context) {
	e.mu.Lock()
	if e.kick == nil {
		e.kick = make(chan struct{}, 1)
	}
	kick := e.kick
	e.mu.Unlock()
	go func() {
		t := time.NewTimer(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			case <-kick:
			}
			if _, err := e.Wake(ctx); err != nil && ctx.Err() == nil {
				e.log().Warn("second brain: a wake failed", "component", "brain", "err", err)
			}
			if !t.Stop() {
				select {
				case <-t.C:
				default:
				}
			}
			t.Reset(Interval)
		}
	}()
}

// Kick asks for a wake now (a setting turned on, a backfill asked for).
func (e *Engine) Kick() {
	e.mu.Lock()
	k := e.kick
	e.mu.Unlock()
	if k == nil {
		return
	}
	select {
	case k <- struct{}{}:
	default:
	}
}

// Wake reads up to Batch sessions, if the extraction may run, and returns
// how many it read. One wake at a time.
func (e *Engine) Wake(ctx context.Context) (int, error) {
	if !e.Enabled() {
		return 0, nil
	}
	e.mu.Lock()
	if e.running {
		e.mu.Unlock()
		return 0, nil
	}
	e.running = true
	e.lastWake = e.now()
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		e.running = false
		e.mu.Unlock()
	}()
	cands, err := e.candidates(ctx, 25)
	if err != nil {
		return 0, err
	}
	read := 0
	for _, c := range cands {
		if read >= Batch || ctx.Err() != nil || !e.Enabled() {
			break
		}
		if e.spent(ctx) >= e.dailyCap() {
			e.setError("today's token limit is reached; reading resumes as the day rolls over")
			break
		}
		did, err := e.readSession(ctx, c)
		if err != nil {
			// A failure is recorded and retried later; the next session goes on.
			e.setError(err.Error())
			e.log().Warn("second brain: a read failed", "component", "brain", "session", c.SessionID, "err", err)
		}
		if did {
			read++
		}
	}
	return read, nil
}

func (e *Engine) setError(s string) {
	e.mu.Lock()
	e.lastError = s
	e.mu.Unlock()
}

// readFrom is how far back the extraction reads: when it was turned on, or
// the backfill's start when that is earlier.
func (e *Engine) readFrom() int64 {
	c := e.Config()
	from := c.Since
	if c.BackfillSince > 0 && (from == 0 || c.BackfillSince < from) {
		from = c.BackfillSince
	}
	return from
}

// candidates lists sessions with unread events, quiet for IdleAfter, that
// are not waiting out a failure, newest first.
func (e *Engine) candidates(ctx context.Context, limit int) ([]store.BrainCandidate, error) {
	now := e.now()
	all, err := store.BrainCandidates(ctx, e.Store.DB(), e.readFrom(), now.Add(-IdleAfter).UnixMilli(), limit)
	if err != nil {
		return nil, err
	}
	out := all[:0]
	for _, c := range all {
		n, last, err := store.BrainFailures(ctx, e.Store.DB(), c.SessionID)
		if err != nil {
			return nil, err
		}
		if n > 0 && now.UnixMilli() < last+(retryAfter<<(n-1)).Milliseconds() {
			continue
		}
		out = append(out, c)
	}
	return out, nil
}

func (e *Engine) dailyCap() int64 {
	if n := e.Config().DailyTokens; n > 0 {
		return int64(n)
	}
	return DefaultDailyTokens
}

func (e *Engine) spent(ctx context.Context) int64 {
	n, err := store.BrainTokensSince(ctx, e.Store.DB(), e.now().Add(-24*time.Hour).UnixMilli())
	if err != nil {
		return 0
	}
	return n
}

func (e *Engine) model() string {
	if m := strings.TrimSpace(e.Config().Model); m != "" {
		return m
	}
	return DefaultModel
}

// readSession reads one session: skips it when there is too little to say,
// gives up after MaxFailures, else asks claude and keeps what comes back.
// did is true when claude was called.
func (e *Engine) readSession(ctx context.Context, c store.BrainCandidate) (did bool, err error) {
	db := e.Store.DB()
	started := e.now().UnixMilli()
	run := store.BrainRun{SessionID: c.SessionID, FromEventID: c.Cursor, ThroughEventID: c.MaxEventID, StartedAt: started, Model: e.model()}
	n, _, err := store.BrainFailures(ctx, db, c.SessionID)
	if err != nil {
		return false, err
	}
	if n >= MaxFailures {
		run.Status, run.Error, run.FinishedAt = store.BrainRunSkipped, "gave up after repeated failures", started
		_, err := store.InsertBrainRun(ctx, db, run)
		return false, err
	}
	passages, err := store.BrainPassages(ctx, db, c.SessionID, c.Cursor, 400)
	if err != nil {
		return false, err
	}
	topics, err := store.BrainEntityTitles(ctx, db, store.BrainTopic, topicsSent)
	if err != nil {
		return false, err
	}
	in := BuildInput(c.Project, topics, passages)
	if in.ProseRunes < MinProseRunes {
		run.Status, run.FinishedAt = store.BrainRunSkipped, started
		_, err := store.InsertBrainRun(ctx, db, run)
		return false, err
	}
	res, callErr := e.Runner.Run(ctx, Request{System: System, Prompt: in.Prompt, Model: e.model()})
	run.FinishedAt = e.now().UnixMilli()
	run.TokensIn, run.TokensOut, run.CostUSD = res.TokensIn, res.TokensOut, res.CostUSD
	if res.Model != "" {
		run.Model = res.Model
	}
	if callErr != nil {
		if ctx.Err() != nil {
			return true, ctx.Err()
		}
		run.Status, run.Error = store.BrainRunFailed, clip(callErr.Error(), 500)
		if _, err := store.InsertBrainRun(ctx, db, run); err != nil {
			return true, err
		}
		return true, callErr
	}
	run.Status = store.BrainRunOK
	var added []store.BrainNode
	err = e.Store.WithTx(ctx, func(q store.Querier) error {
		id, err := store.InsertBrainRun(ctx, q, run)
		if err != nil {
			return err
		}
		added, err = keep(ctx, q, id, c, in.Passages, res.Memories, run.FinishedAt)
		if err != nil {
			return err
		}
		return store.SetBrainRunNodes(ctx, q, id, len(added))
	})
	if err != nil {
		return true, err
	}
	e.setError("")
	for _, n := range added {
		e.publish(n)
	}
	return true, nil
}

// keep stores the memories a read returned, each linked to its project, its
// topics and the memories it names, and returns the new nodes.
func keep(ctx context.Context, q store.Querier, runID int64, c store.BrainCandidate, passages []store.BrainPassage, mems []Memory, now int64) ([]store.BrainNode, error) {
	if len(mems) > 8 {
		mems = mems[:8]
	}
	// The passage a memory cites, else the last answer read.
	var lastAnswer store.BrainPassage
	for _, p := range passages {
		if !p.User {
			lastAnswer = p
		}
	}
	var projectID int64
	if c.Project != "" {
		id, err := store.EnsureBrainEntity(ctx, q, store.BrainProject, c.Project, store.BrainSource{}, false, runID, now)
		if err != nil {
			return nil, err
		}
		projectID = id
	}
	ids := make([]int64, len(mems))
	var added []store.BrainNode
	for i, m := range mems {
		kind := strings.ToLower(strings.TrimSpace(m.Kind))
		if !store.IsBrainKind(kind) || store.IsBrainEntity(kind) {
			kind = store.BrainIdea
		}
		// A model asked for plain text still sends Markdown now and then; a
		// title is one line, so its heading marks and stray newlines go.
		m.Title = strings.Join(strings.Fields(strings.TrimLeft(strings.TrimSpace(m.Title), "#> ")), " ")
		if store.NormTitle(m.Title) == "" {
			continue
		}
		src := lastAnswer
		if m.Passage >= 1 && m.Passage <= len(passages) {
			src = passages[m.Passage-1]
		}
		n, _, err := store.InsertBrainNode(ctx, q, store.BrainNode{
			Kind: kind, Title: m.Title, Summary: m.Summary, RunID: runID,
			Source: store.BrainSource{SessionID: c.SessionID, EventID: src.EventID, Ts: src.Ts, Project: c.Project},
		}, now)
		if err != nil {
			if errors.Is(err, store.ErrBrainInvalid) {
				continue
			}
			return nil, err
		}
		ids[i] = n.ID
		added = append(added, n)
		if projectID > 0 {
			if err := store.LinkBrain(ctx, q, n.ID, projectID, store.EdgePartOf, 1, now); err != nil {
				return nil, err
			}
		}
		for j, t := range m.Topics {
			if j >= 3 || store.NormTitle(t) == "" {
				continue
			}
			tid, err := store.EnsureBrainEntity(ctx, q, store.BrainTopic, t, store.BrainSource{}, false, runID, now)
			if err != nil {
				return nil, err
			}
			if err := store.LinkBrain(ctx, q, n.ID, tid, store.EdgePartOf, 1, now); err != nil {
				return nil, err
			}
		}
	}
	for i, m := range mems {
		if ids[i] == 0 {
			continue
		}
		for _, link := range []struct {
			to   []int
			kind string
		}{{m.Related, store.EdgeRelates}, {m.Contradicts, store.EdgeContradicts}} {
			for _, j := range link.to {
				if j >= 0 && j < len(ids) && j != i && ids[j] != 0 {
					if err := store.LinkBrain(ctx, q, ids[i], ids[j], link.kind, 1, now); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	return added, nil
}

func (e *Engine) publish(n store.BrainNode) {
	if e.Bus == nil {
		return
	}
	e.Bus.Publish(bus.Frame{Type: bus.FrameBrain, Data: map[string]any{"id": n.ID, "op": "added", "kind": n.Kind, "title": n.Title, "auto": true}})
}

// Status is the extraction's state for GET /v1/brain/status.
type Status struct {
	// Chosen is whether the user has answered the offer to turn it on;
	// Enabled whether it is on (a yes).
	Chosen      bool   `json:"chosen"`
	On          bool   `json:"on"`
	Enabled     bool   `json:"enabled"`
	ClaudeFound bool   `json:"claude_found"`
	Model       string `json:"model"`
	DailyTokens int64  `json:"daily_tokens"`
	// Spent is what the reads used in the last 24 hours.
	Spent   int64 `json:"spent"`
	Running bool  `json:"running"`
	// Pending is how many sessions wait to be read (counted up to 200).
	Pending       int    `json:"pending"`
	Since         int64  `json:"since,omitempty"`
	BackfillSince int64  `json:"backfill_since,omitempty"`
	LastWake      int64  `json:"last_wake,omitempty"`
	LastError     string `json:"last_error,omitempty"`
	// Recent is the newest reads that did something.
	Recent []store.BrainRun `json:"recent"`
}

// Status reports the extraction's state.
func (e *Engine) Status(ctx context.Context) Status {
	c := e.Config()
	st := Status{
		Chosen: c.Auto != nil, On: c.Auto != nil && *c.Auto, Enabled: e.Enabled(),
		Model: e.model(), DailyTokens: e.dailyCap(), Spent: e.spent(ctx),
		Since: c.Since, BackfillSince: c.BackfillSince, Recent: []store.BrainRun{},
	}
	if e.ClaudeFound != nil {
		st.ClaudeFound = e.ClaudeFound()
	}
	e.mu.Lock()
	st.Running, st.LastError = e.running, e.lastError
	if !e.lastWake.IsZero() {
		st.LastWake = e.lastWake.UnixMilli()
	}
	e.mu.Unlock()
	if st.On {
		if cands, err := e.candidates(ctx, 200); err == nil {
			st.Pending = len(cands)
		}
	}
	if runs, err := store.LastBrainRuns(ctx, e.Store.DB(), 5); err == nil {
		st.Recent = runs
	}
	return st
}

// Estimate is what reading back to a moment would take: sessions with
// enough prose to be read, and the tokens that is likely to cost — an
// estimate from the transcript's length (about four characters a token) and
// the measured overhead of one read, not a measurement.
type Estimate struct {
	Sessions  int   `json:"sessions"`
	Tokens    int64 `json:"tokens_estimate"`
	Days      int   `json:"days_estimate"`
	DailyCap  int64 `json:"daily_tokens"`
	Truncated bool  `json:"truncated,omitempty"`
}

// EstimateFrom counts what a backfill to `since` would read.
func (e *Engine) EstimateFrom(ctx context.Context, since int64) (Estimate, error) {
	const most = 2000
	cands, err := store.BrainCandidates(ctx, e.Store.DB(), since, e.now().Add(-IdleAfter).UnixMilli(), most)
	if err != nil {
		return Estimate{}, err
	}
	est := Estimate{DailyCap: e.dailyCap(), Truncated: len(cands) == most}
	for _, c := range cands {
		passages, err := store.BrainPassages(ctx, e.Store.DB(), c.SessionID, c.Cursor, 400)
		if err != nil {
			return Estimate{}, err
		}
		in := BuildInput(c.Project, nil, passages)
		if in.ProseRunes < MinProseRunes {
			continue
		}
		est.Sessions++
		est.Tokens += int64(len(in.Prompt)/4) + OverheadTokens + 400
	}
	if est.Tokens > 0 {
		est.Days = int((est.Tokens + est.DailyCap - 1) / est.DailyCap)
	}
	return est, nil
}
