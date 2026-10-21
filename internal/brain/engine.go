package brain

import (
	"context"
	"errors"
	"log/slog"
	"sort"
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
	// Batch sessions. A wake that read a full Batch is followed by the next
	// after Continue, not Interval: while a build has sessions waiting it
	// reads one after another, within the daily cap, so the screen shows it
	// working instead of a pause of five minutes between every four.
	Interval = 5 * time.Minute
	Batch    = 4
	Continue = 3 * time.Second
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
	// HandoffOn reports whether new sessions are handed what the last one
	// left (Settings → Memory between sessions), which is how memories reach
	// agents. Nil reads as off.
	HandoffOn func() bool
	Runner    Runner

	mu      sync.Mutex
	running bool
	// reading is the session a read is asking claude about right now.
	reading   *Reading
	lastWake  time.Time
	lastError string
	kick      chan struct{}
	// nextWake is when the loop wakes next: a minute after Start, Interval
	// after each wake, at once after a Kick. Zero until Start.
	nextWake time.Time
	// stopped is closed when Start's loop has returned (Wait).
	stopped chan struct{}
}

// Wait blocks until the loop Start began has returned, after its context
// ended; at once when Start never ran. The daemon waits here before closing
// the database a wake reads.
func (e *Engine) Wait() {
	e.mu.Lock()
	ch := e.stopped
	e.mu.Unlock()
	if ch != nil {
		<-ch
	}
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
	e.nextWake = e.now().Add(time.Minute)
	stopped := make(chan struct{})
	e.stopped = stopped
	e.mu.Unlock()
	go func() {
		defer close(stopped)
		t := time.NewTimer(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			case <-kick:
			}
			n, err := e.Wake(ctx)
			if err != nil && ctx.Err() == nil {
				e.log().Warn("second brain: a wake failed", "component", "brain", "err", err)
			}
			wait := Interval
			if n >= Batch {
				// More may be waiting: go on after a breath.
				wait = Continue
			}
			if !t.Stop() {
				select {
				case <-t.C:
				default:
				}
			}
			t.Reset(wait)
			e.mu.Lock()
			e.nextWake = e.now().Add(wait)
			if len(kick) > 0 {
				// A Kick arrived during the wake: the next one is now.
				e.nextWake = e.now()
			}
			e.mu.Unlock()
		}
	}()
}

// Kick asks for a wake now (a setting turned on, a backfill asked for). It
// never blocks and never runs the wake itself: the wake runs on Start's
// goroutine, under the daemon's context rather than a request's. Kicks that
// arrive together make one wake, and a wake already running is not doubled
// (Wake runs one at a time).
func (e *Engine) Kick() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.kick == nil {
		return
	}
	select {
	case e.kick <- struct{}{}:
	default:
	}
	e.nextWake = e.now()
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
	e.startReading(ctx, c, in.Passages, started)
	res, callErr := e.Runner.Run(ctx, Request{System: System, Prompt: in.Prompt, Model: e.model()})
	if callErr == nil {
		e.setPhase(PhaseLinking)
	}
	run.FinishedAt = e.now().UnixMilli()
	run.TokensIn, run.TokensOut, run.CostUSD = res.TokensIn, res.TokensOut, res.CostUSD
	if res.Model != "" {
		run.Model = res.Model
	}
	if callErr != nil {
		// The read ends once it is recorded, so the frame that says so
		// finds it in the status.
		var runID int64
		defer func() { e.publishDone(e.stopReading(), runID, 0) }()
		if ctx.Err() != nil {
			return true, ctx.Err()
		}
		run.Status, run.Error = store.BrainRunFailed, clip(callErr.Error(), 500)
		id, err := store.InsertBrainRun(ctx, db, run)
		if err != nil {
			return true, err
		}
		runID = id
		return true, callErr
	}
	run.Status = store.BrainRunOK
	var added []store.BrainNode
	var runID int64
	err = e.Store.WithTx(ctx, func(q store.Querier) error {
		id, err := store.InsertBrainRun(ctx, q, run)
		if err != nil {
			return err
		}
		runID = id
		added, err = keep(ctx, q, id, c, in.Passages, res.Memories, run.FinishedAt)
		if err != nil {
			return err
		}
		return store.SetBrainRunNodes(ctx, q, id, len(added))
	})
	r := e.stopReading()
	if err != nil {
		e.publishDone(r, 0, 0)
		return true, err
	}
	e.setError("")
	agent := ""
	if r != nil {
		agent = r.Agent
	}
	for _, n := range added {
		e.publish(n, agent)
	}
	// After the memories, so a screen that waits for the read's end has
	// every one of them by then.
	e.publishDone(r, runID, len(added))
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
		if !store.IsBrainKind(kind) || store.IsBrainEntity(kind) || kind == store.BrainNote {
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

// A read's phases, in order: claude is asked for the memories, then what it
// returned is stored and linked into the graph. Reading the session's prose
// from the database comes before both and takes milliseconds; it is not a
// phase of its own.
const (
	PhaseExtracting = "extracting"
	PhaseLinking    = "linking"
)

// Reading is the session a read is asking claude about, for the status's
// "reading now" line.
type Reading struct {
	SessionID string `json:"session_id"`
	// Title is the session's own name, else its first prompt, clipped.
	Title   string `json:"title,omitempty"`
	Agent   string `json:"agent,omitempty"`
	Project string `json:"project,omitempty"`
	// LastEventAt is when the session last did something; StartedAt when
	// this read began. Unix ms.
	LastEventAt int64 `json:"last_event_at,omitempty"`
	StartedAt   int64 `json:"started_at"`
	// Phase is PhaseExtracting while claude is asked, PhaseLinking while
	// its memories are stored and linked.
	Phase string `json:"phase"`
	// Passages is how many passages of the session's prose were sent.
	Passages int `json:"passages"`
}

// startReading records the session being read and says so on the bus.
func (e *Engine) startReading(ctx context.Context, c store.BrainCandidate, passages []store.BrainPassage, at int64) {
	r := &Reading{SessionID: c.SessionID, Project: c.Project, LastEventAt: c.LastEventAt, StartedAt: at, Phase: PhaseExtracting, Passages: len(passages)}
	if title, agent, last, err := store.BrainSessionInfo(ctx, e.Store.DB(), c.SessionID); err == nil {
		r.Title, r.Agent = title, agent
		if last > 0 {
			r.LastEventAt = last
		}
	}
	if r.Title == "" {
		for _, p := range passages {
			if p.User {
				r.Title = p.Text
				break
			}
		}
	}
	r.Title = clip(strings.Join(strings.Fields(r.Title), " "), 80)
	e.mu.Lock()
	e.reading = r
	e.mu.Unlock()
	if e.Bus != nil {
		e.Bus.Publish(bus.Frame{Type: bus.FrameBrain, Data: map[string]any{
			"op": "progress", "phase": "start", "session": r.SessionID, "project": r.Project, "agent": r.Agent,
		}})
	}
}

// setPhase moves the read on to its next phase. No frame: linking takes
// milliseconds, and the read's end follows at once with one.
func (e *Engine) setPhase(p string) {
	e.mu.Lock()
	if e.reading != nil {
		e.reading.Phase = p
	}
	e.mu.Unlock()
}

// stopReading clears the session being read and returns it (nil when none
// was), for the frame that says the read ended.
func (e *Engine) stopReading() *Reading {
	e.mu.Lock()
	r := e.reading
	e.reading = nil
	e.mu.Unlock()
	return r
}

// publishDone says a read ended: a `brain` frame with op "progress", phase
// "done", the read's run (0 when none was recorded), the session, project
// and agent it read, and how many memories it kept, so a screen showing the
// build reads the status again and the sidebar can show one arrival for the
// whole read. Screens showing memories ignore it.
func (e *Engine) publishDone(r *Reading, runID int64, added int) {
	if e.Bus == nil {
		return
	}
	data := map[string]any{"op": "progress", "phase": "done", "added": added}
	if runID > 0 {
		data["run"] = runID
	}
	if r != nil {
		data["session"], data["project"], data["agent"] = r.SessionID, r.Project, r.Agent
	}
	e.Bus.Publish(bus.Frame{Type: bus.FrameBrain, Data: data})
}

// publish says a memory was kept by a read: its run and the agent of the
// session read ride along, so a screen can tell one read's memories apart.
func (e *Engine) publish(n store.BrainNode, agent string) {
	if e.Bus == nil {
		return
	}
	data := map[string]any{"id": n.ID, "op": "added", "kind": n.Kind, "title": n.Title, "auto": true}
	if n.RunID > 0 {
		data["run"] = n.RunID
	}
	if agent != "" {
		data["agent"] = agent
	}
	n.Source.AddToFrame(data)
	e.Bus.Publish(bus.Frame{Type: bus.FrameBrain, Data: data})
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
	// Spent is what the reads used in the last 24 hours; SpentUSD what
	// claude reported they cost (at API list price), summed.
	Spent    int64   `json:"spent"`
	SpentUSD float64 `json:"spent_usd"`
	// Stage is where the build is, one of the Stage* values.
	Stage string `json:"stage"`
	// LastRead is when the newest read that kept something finished, unix ms.
	LastRead int64 `json:"last_read,omitempty"`
	// NewToday is the memories added since local midnight, by hand or read.
	NewToday int `json:"new_today"`
	// Topics and Links are the graph's topics and the links between nodes.
	Topics int `json:"topics"`
	Links  int `json:"links"`
	// Handoff is how the memories reach agents: a new session in a
	// repository is handed up to five of its memories with the handoff.
	Handoff Handoff `json:"handoff"`
	Running bool    `json:"running"`
	// Pending is how many sessions wait to be read (counted up to 200).
	Pending int `json:"pending"`
	// Reading is the session being read right now, while a read runs.
	Reading *Reading `json:"reading,omitempty"`
	// Build is the progress through everything in reach — the sessions
	// since `since` or `backfill_since` — while it is on.
	Build         *Build `json:"build,omitempty"`
	Since         int64  `json:"since,omitempty"`
	BackfillSince int64  `json:"backfill_since,omitempty"`
	LastWake      int64  `json:"last_wake,omitempty"`
	// NextWake is when the next wake is due, unix ms; absent while it is off.
	// At or before now when one was just asked for or is running.
	NextWake  int64  `json:"next_wake,omitempty"`
	LastError string `json:"last_error,omitempty"`
	// Recent is the newest reads that did something.
	Recent []store.BrainRun `json:"recent"`
	// Agents24h is the agents whose sessions a read went through in the
	// last 24 hours, most sessions first: the faces on the sidebar's card.
	Agents24h []store.BrainAgentRead `json:"agents_24h"`
}

// The build's stages, as Status.Stage names them.
const (
	StageOff        = "off"        // not turned on, or paused
	StageNoClaude   = "no_claude"  // on, but no claude to read with
	StageLimit      = "limit"      // sessions wait, today's tokens are used
	StageExtracting = "extracting" // claude is reading a session
	StageLinking    = "linking"    // a read's memories are being stored
	StageWaiting    = "waiting"    // sessions wait; the next read is due
	StageUpToDate   = "up_to_date" // nothing waits
)

// Handoff is how often memories reached agents: sessions started that were
// handed some, and how many memories in all, in the last 24 hours and since
// it was first counted (migration 0058).
type Handoff struct {
	// On is whether new sessions are handed anything at all.
	On          bool `json:"on"`
	Sessions24h int  `json:"sessions_24h"`
	Memories24h int  `json:"memories_24h"`
	Sessions    int  `json:"sessions"`
	Memories    int  `json:"memories"`
}

// Build is how far the extraction has got through the sessions in reach.
type Build struct {
	// From is the start of what is in reach, unix ms (the earlier of `since`
	// and `backfill_since`).
	From int64 `json:"from"`
	// Sessions is Read plus Pending: the sessions in reach that are read, or
	// quiet and waiting to be. A live session joins once it goes quiet.
	Sessions int `json:"sessions"`
	Read     int `json:"read"`
	// Memories is what the reads of those sessions kept.
	Memories int `json:"memories"`
	// Truncated is set when the waiting sessions were counted only to 200.
	Truncated bool `json:"truncated,omitempty"`
	// Sources is the same per project, most sessions first, at most 12.
	Sources []BuildSource `json:"sources"`
}

// BuildSource is one project's share of a build.
type BuildSource struct {
	Project  string `json:"project"`
	Read     int    `json:"read"`
	Pending  int    `json:"pending"`
	Memories int    `json:"memories"`
}

// statusPending is how far the status counts the waiting sessions.
const statusPending = 200

// build counts the progress through what is in reach; cands are the
// sessions waiting (from candidates). A session read before and waiting
// again counts once, as waiting, with the memories it already gave.
func (e *Engine) build(ctx context.Context, cands []store.BrainCandidate) (*Build, error) {
	from := e.readFrom()
	if from <= 0 {
		return nil, nil
	}
	read, err := store.BrainReadSessions(ctx, e.Store.DB(), from)
	if err != nil {
		return nil, err
	}
	b := &Build{From: from, Truncated: len(cands) >= statusPending, Sources: []BuildSource{}}
	by := map[string]*BuildSource{}
	src := func(p string) *BuildSource {
		if s := by[p]; s != nil {
			return s
		}
		s := &BuildSource{Project: p}
		by[p] = s
		return s
	}
	waiting := make(map[string]bool, len(cands))
	for _, c := range cands {
		waiting[c.SessionID] = true
		src(c.Project).Pending++
	}
	for _, r := range read {
		s := src(r.Project)
		s.Memories += r.Memories
		b.Memories += r.Memories
		if !waiting[r.SessionID] {
			s.Read++
			b.Read++
		}
	}
	b.Sessions = b.Read + len(cands)
	for _, s := range by {
		b.Sources = append(b.Sources, *s)
	}
	sort.Slice(b.Sources, func(i, j int) bool {
		x, y := b.Sources[i], b.Sources[j]
		if x.Read+x.Pending != y.Read+y.Pending {
			return x.Read+x.Pending > y.Read+y.Pending
		}
		return x.Project < y.Project
	})
	if len(b.Sources) > 12 {
		b.Sources = b.Sources[:12]
	}
	return b, nil
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
	if e.reading != nil {
		r := *e.reading
		st.Reading = &r
	}
	if !e.lastWake.IsZero() {
		st.LastWake = e.lastWake.UnixMilli()
	}
	if st.Enabled && !e.nextWake.IsZero() {
		st.NextWake = e.nextWake.UnixMilli()
	}
	e.mu.Unlock()
	if st.On {
		if cands, err := e.candidates(ctx, statusPending); err == nil {
			st.Pending = len(cands)
			if b, err := e.build(ctx, cands); err == nil {
				st.Build = b
			}
		}
	}
	if runs, err := store.LastBrainRuns(ctx, e.Store.DB(), 5); err == nil {
		st.Recent = runs
	}
	e.measure(ctx, &st)
	st.Stage = stage(st, e.Config().Auto != nil && *e.Config().Auto)
	return st
}

// measure fills in the counted figures: cost, the last read, today's new
// memories, the graph's size and the handoff's reach. A failed count stays 0.
func (e *Engine) measure(ctx context.Context, st *Status) {
	db := e.Store.DB()
	now := e.now()
	day := now.Add(-24 * time.Hour).UnixMilli()
	st.SpentUSD, _ = store.BrainCostSince(ctx, db, day)
	st.LastRead, _ = store.BrainLastRead(ctx, db)
	y, m, d := now.Date()
	st.NewToday, _ = store.CountBrainMemoriesSince(ctx, db, time.Date(y, m, d, 0, 0, 0, 0, now.Location()).UnixMilli())
	st.Topics, st.Links, _ = store.BrainGraphCounts(ctx, db)
	if e.HandoffOn != nil {
		st.Handoff.On = e.HandoffOn()
	}
	st.Handoff.Sessions24h, st.Handoff.Memories24h, _ = store.BrainHandedSince(ctx, db, day)
	st.Handoff.Sessions, st.Handoff.Memories, _ = store.BrainHandedSince(ctx, db, 0)
	st.Agents24h = []store.BrainAgentRead{}
	if a, err := store.BrainAgentsSince(ctx, db, day); err == nil {
		st.Agents24h = a
	}
}

// stage names where the build is, from the status it is part of.
func stage(st Status, on bool) string {
	switch {
	case !on:
		return StageOff
	case st.Reading != nil && st.Reading.Phase == PhaseLinking:
		return StageLinking
	case st.Reading != nil:
		return StageExtracting
	case !st.ClaudeFound:
		return StageNoClaude
	case st.Pending > 0 && st.Spent >= st.DailyTokens:
		return StageLimit
	case st.Pending > 0:
		return StageWaiting
	}
	return StageUpToDate
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
