package hermes

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/ingest"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/sessionlink"
	"github.com/dspv/caprock/internal/store"
)

// Ingester copies Hermes's sessions into Caprock's store.
//
// It polls, as the OpenCode reader does: Hermes has outbound webhooks and
// shell hooks, but cost lives only in state.db, and the database is the one
// source that also carries history from before Caprock was installed.
//
// Hermes keeps usage per session, not per message: every API call adds its
// tokens and its cost to the session's counters (update_token_counts, the
// delta path — the only one 0.21.6 uses). So the importer reconciles. Each
// pass it compares the session's counters with what Caprock has stored for it
// and records the difference on the newest assistant message of the pass, or,
// when no new message arrived with it, on a usage record of its own. Caprock's
// totals therefore equal Hermes's, whatever order messages and counters were
// flushed in, and a re-read or a restart adds nothing: the difference is zero.
//
// Every write is keyed — messages by Hermes's message id, usage records by
// the counters they bring the session up to — and `(session_id, key)` is
// unique in the store.
type Ingester struct {
	db    *sql.DB
	rec   *rollup.Recorder
	log   *slog.Logger
	every time.Duration

	mu      sync.Mutex
	seen    map[string]string // session id → fingerprint of what was read
	lastMsg map[string]int64  // session id → highest message id read
	stats   Stats

	// Link files a session under the Caprock session that started it, when
	// Caprock did (internal/sessionlink). Nil keeps Hermes's own ids.
	Link *sessionlink.Linker
}

// Stats is what the daemon reports about the Hermes reader.
type Stats struct {
	Sessions   int   `json:"sessions"`
	Events     int   `json:"events"`
	Unpriced   int   `json:"unpriced,omitempty"`
	Background int   `json:"background,omitempty"`
	LastPoll   int64 `json:"last_poll_ms,omitempty"`
}

// NewIngester builds an ingester over an already-open Hermes database.
func NewIngester(db *sql.DB, rec *rollup.Recorder, log *slog.Logger, every time.Duration) *Ingester {
	if every <= 0 {
		every = 5 * time.Second
	}
	if log == nil {
		log = slog.Default()
	}
	return &Ingester{db: db, rec: rec, log: log, every: every, seen: map[string]string{}, lastMsg: map[string]int64{}}
}

// Stats returns a snapshot of what has been imported.
func (in *Ingester) Stats() Stats {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.stats
}

// Run polls until the context is cancelled, importing once immediately.
func (in *Ingester) Run(ctx context.Context) error {
	t := time.NewTicker(in.every)
	defer t.Stop()
	for {
		if err := in.Once(ctx); err != nil && ctx.Err() == nil {
			// Hermes may hold the database past the busy timeout, or the
			// user may have deleted it. Not fatal: the next tick tries again.
			in.log.Debug("hermes poll failed", "component", "hermes", "err", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// Once reads everything that changed since the last pass.
func (in *Ingester) Once(ctx context.Context) error {
	sessions, err := Sessions(ctx, in.db)
	if err != nil {
		return err
	}
	byID := make(map[string]Session, len(sessions))
	for _, s := range sessions {
		byID[s.ID] = s
	}
	background := 0
	for _, s := range sessions {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if s.ParentID == "" && Background(s.Source) {
			background++
		}
		fp := fingerprint(s)
		in.mu.Lock()
		same := in.seen[s.ID] == fp
		in.mu.Unlock()
		if same {
			continue
		}
		if err := in.session(ctx, s, byID); err != nil {
			// One unreadable session must not stop the rest.
			in.log.Debug("hermes session failed", "component", "hermes", "session", s.ID, "err", err)
			continue
		}
		in.mu.Lock()
		in.seen[s.ID] = fp
		in.stats.Sessions = len(in.seen)
		in.mu.Unlock()
	}
	in.mu.Lock()
	in.stats.Background = background
	in.stats.LastPoll = time.Now().UnixMilli()
	in.mu.Unlock()
	return nil
}

// fingerprint changes whenever anything the importer reads changes.
func fingerprint(s Session) string {
	return fmt.Sprintf("%d|%d|%d|%d|%d|%d|%d|%v|%v|%s|%s|%d|%s",
		s.Messages, s.APICalls, s.Tokens(), s.ReasoningTokens, s.ToolCalls,
		s.LastActivity.UnixMilli(), s.Ended.UnixMilli(), s.Estimated, s.Actual,
		s.CostStatus, s.CostSource, len(s.Title), s.Title)
}

// place is where a Hermes session's events are stored.
type place struct {
	storeID string  // the Caprock session they are filed under
	agentID string  // the subagent's own id, "" on a main thread
	main    Session // the main-thread session: its folder and source
}

// subagent reports whether s is a delegated child of its parent, which
// Caprock files inside the parent as Claude Code files a subagent. Hermes
// uses parent_session_id for three things, and says which by itself
// (hermes_state_common.py): `_delegate_from` marks a delegated child;
// `_branched_from` and `_reset_from` mark a branch or a reset, which are new
// conversations of their own; and a child of a row that ended on
// `compression` is the same conversation continuing under a new id. A child
// that carries none of those is one Hermes's own pickers hide as a subagent
// run, and it is read as one here.
func subagent(s Session, byID map[string]Session) bool {
	if s.ParentID == "" {
		return false
	}
	if s.DelegateFrom != "" && s.DelegateFrom == s.ParentID {
		return true
	}
	if s.BranchedFrom == s.ParentID || s.ResetFrom != "" {
		return false
	}
	if p, ok := byID[s.ParentID]; ok && p.EndReason == "compression" {
		return false
	}
	return true
}

func (in *Ingester) place(ctx context.Context, s Session, byID map[string]Session) place {
	cur := s
	agentID := ""
	for depth := 0; depth < 16 && subagent(cur, byID); depth++ {
		p, ok := byID[cur.ParentID]
		if !ok {
			break // the parent was pruned: the child stands on its own
		}
		if agentID == "" {
			agentID = s.ID
		}
		cur = p
	}
	return place{storeID: in.storeID(ctx, cur), agentID: agentID, main: cur}
}

// storeID is the Caprock session a main-thread Hermes session is stored
// under: the one Caprock spawned it from, when a spawn is waiting in the same
// folder and Hermes's id says the CLI started within the window after it,
// else Hermes's own id. Only a session started in Hermes's own CLI or TUI is
// a candidate; a cron run or a chat is never one Caprock launched.
func (in *Ingester) storeID(ctx context.Context, s Session) string {
	if in.Link == nil {
		return s.ID
	}
	started, ok := IDTime(s.ID)
	if !ok {
		started = s.Started
	}
	return in.Link.Resolve(ctx, Agent, sessionlink.Candidate{
		NativeID: s.ID,
		Cwd:      s.Cwd,
		Started:  started,
		Eligible: s.ParentID == "" && (s.Source == "cli" || s.Source == "tui"),
	})
}

// usage is a difference between Hermes's counters and Caprock's.
type usage struct {
	in, out, cacheRead, cacheWrite int64
	cost                           *float64
}

func (u usage) zero() bool {
	return u.in == 0 && u.out == 0 && u.cacheRead == 0 && u.cacheWrite == 0 && (u.cost == nil || *u.cost == 0)
}

// pending is what Hermes's counters say that Caprock has not yet stored for
// one session (one thread of it), clamped at zero: a counter that went down
// (a session Hermes rewound or rebuilt) is not turned into negative spend.
func (in *Ingester) pending(ctx context.Context, p place, s Session) (usage, error) {
	var tin, tout, cr, cw int64
	var spent float64
	err := in.rec.Store.DB().QueryRowContext(ctx, `
		SELECT COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0),
		       COALESCE(SUM(cache_read),0), COALESCE(SUM(cache_write),0),
		       COALESCE(SUM(cost_usd),0)
		FROM events
		WHERE sid = (SELECT sid FROM sessions WHERE session_id = ?) AND source = ? AND kind = 'turn.assistant' AND COALESCE(agent_id,'') = ?`,
		p.storeID, string(event.SourceHermes), p.agentID).Scan(&tin, &tout, &cr, &cw, &spent)
	if err != nil {
		return usage{}, fmt.Errorf("read stored usage: %w", err)
	}
	u := usage{
		in:         max(0, s.InputTokens-tin),
		out:        max(0, s.OutputTokens-tout),
		cacheRead:  max(0, s.CacheReadTokens-cr),
		cacheWrite: max(0, s.CacheWriteTokens-cw),
	}
	if usd, _, ok := s.Cost(); ok {
		d := usd - spent
		if d < 0 || math.Abs(d) < 1e-9 {
			d = 0
		}
		u.cost = &d
	}
	return u, nil
}

// session imports one Hermes session: its prompts, replies and tool calls,
// and whatever of its usage Caprock has not stored yet.
func (in *Ingester) session(ctx context.Context, s Session, byID map[string]Session) error {
	p := in.place(ctx, s, byID)
	in.mu.Lock()
	after := in.lastMsg[s.ID]
	in.mu.Unlock()
	msgs, err := Messages(ctx, in.db, s.ID, after)
	if err != nil {
		return err
	}
	due, err := in.pending(ctx, p, s)
	if err != nil {
		return err
	}
	_, basis, priced := s.Cost()
	bg := Background(p.main.Source)
	info := rollup.SessionInfo{Cwd: s.Cwd, GitBranch: s.Branch, Model: s.Model, Agent: Agent}
	if p.agentID == "" {
		info.Title = s.Title
	}
	common := func(fields map[string]any) map[string]any {
		fields["hermes_source"] = p.main.Source
		if bg {
			fields["background"] = true
		}
		if p.agentID != "" {
			// The key every source with subagents writes, so screens that
			// leave subagents out leave this one out too.
			fields["sidechain"] = true
		}
		return fields
	}

	// The usage goes on the newest reply this pass reads.
	carrier := -1
	if !due.zero() {
		for i := len(msgs) - 1; i >= 0; i-- {
			if msgs[i].Role == "assistant" && !msgs[i].Summary {
				carrier = i
				break
			}
		}
	}
	carried := false
	last := after
	for i, m := range msgs {
		last = max(last, m.ID)
		ts := m.At
		if ts.IsZero() {
			ts = s.LastActivity
		}
		switch {
		case m.Summary:
			// Hermes's own summary of a compressed conversation, not a reply.
		case m.Role == "user" && m.Content != "":
			payload, _ := json.Marshal(common(map[string]any{"prompt": ingest.ClipAssistantText(m.Content), "cwd": s.Cwd}))
			if _, err := in.record(ctx, &event.Event{
				Ts: ts, SessionID: p.storeID, AgentID: p.agentID, Source: event.SourceHermes,
				Kind: event.KindTurnUser, Payload: payload, Key: "hm-user:" + strconv.FormatInt(m.ID, 10),
			}, info); err != nil {
				return err
			}
		case m.Role == "assistant":
			msgID := "hermes/" + strconv.FormatInt(m.ID, 10)
			fields := common(map[string]any{"text": ingest.ClipAssistantText(m.Content), "model": s.Model, "cwd": s.Cwd})
			ev := &event.Event{
				Ts: ts, SessionID: p.storeID, AgentID: p.agentID, Source: event.SourceHermes,
				Kind: event.KindTurnAssistant, Model: s.Model,
				Key: "hm-msg:" + strconv.FormatInt(m.ID, 10), MsgID: msgID,
			}
			if i == carrier {
				in.carry(ev, fields, due, basis, priced, s)
			}
			ev.Payload, _ = json.Marshal(fields)
			stored, err := in.record(ctx, ev, info)
			if err != nil {
				return err
			}
			if i == carrier && stored {
				carried = true
			}
			for j, c := range ToolCalls(m.ToolCalls) {
				callKey := c.ID
				if callKey == "" {
					callKey = strconv.Itoa(j)
				}
				// Bounded the way every plane bounds a stored tool call: a
				// write_file carries the whole file it wrote.
				input, _ := json.Marshal(ToolInput(c.Name, c.Input, s.Cwd))
				payload, _ := json.Marshal(common(map[string]any{
					"tool_name":   ToolName(c.Name),
					"tool_input":  event.CapToolField(input),
					"cwd":         toolCwd(c, s.Cwd),
					"hermes_tool": c.Name,
				}))
				if _, err := in.record(ctx, &event.Event{
					Ts: ts, SessionID: p.storeID, AgentID: p.agentID, Source: event.SourceHermes,
					Kind: event.KindToolPre, Tool: ToolName(c.Name), Payload: payload,
					Key:   "hm-tool:" + strconv.FormatInt(m.ID, 10) + ":" + callKey,
					MsgID: msgID,
				}, info); err != nil {
					return err
				}
			}
		}
	}
	if !due.zero() && !carried {
		// No new reply to carry it — the counters were flushed after the
		// message, or the message was stored on an earlier pass. A usage
		// record of its own, keyed by the counters it brings the session to,
		// so the same snapshot is stored once.
		ts := s.LastActivity
		if ts.IsZero() {
			ts = s.Started
		}
		fields := common(map[string]any{"usage_only": true, "model": s.Model, "cwd": s.Cwd})
		ev := &event.Event{
			Ts: ts, SessionID: p.storeID, AgentID: p.agentID, Source: event.SourceHermes,
			Kind: event.KindTurnAssistant, Model: s.Model,
			Key: fmt.Sprintf("hm-usage:%s:%d:%d:%d", s.ID, s.Tokens(), s.APICalls, costMicros(s)),
		}
		in.carry(ev, fields, due, basis, priced, s)
		ev.Payload, _ = json.Marshal(fields)
		if _, err := in.record(ctx, ev, info); err != nil {
			return err
		}
	}
	in.mu.Lock()
	in.lastMsg[s.ID] = last
	in.mu.Unlock()

	if p.agentID == "" && p.storeID == s.ID && !s.Ended.IsZero() {
		// Hermes says the conversation is over (an exit, or a compression
		// that continues it under a new id). Only a row of Hermes's own: a
		// session Caprock started is ended by its process, not by this.
		if err := store.SetSessionStatus(ctx, in.rec.Store.DB(), p.storeID, store.StatusEnded); err != nil {
			return err
		}
	}
	return nil
}

// carry puts a usage difference on an event: the tokens, Hermes's cost (nil
// when Hermes has none, so the turn counts as unpriced), and what kind of
// figure the cost is.
func (in *Ingester) carry(ev *event.Event, fields map[string]any, due usage, basis string, priced bool, s Session) {
	ev.Tokens = &event.TokenDelta{In: due.in, Out: due.out, CacheRead: due.cacheRead, CacheWrite: due.cacheWrite}
	if priced && due.cost != nil {
		c := *due.cost
		ev.CostUSD = &c
	}
	fields["cost_basis"] = basis
	if s.CostSource != "" {
		fields["cost_source"] = s.CostSource
	}
	if s.BillingProvider != "" {
		fields["provider"] = s.BillingProvider
	}
	if s.ReasoningTokens > 0 {
		fields["reasoning_tokens"] = s.ReasoningTokens
	}
}

// record stores one event and counts it.
func (in *Ingester) record(ctx context.Context, ev *event.Event, info rollup.SessionInfo) (bool, error) {
	res, err := in.rec.Record(ctx, ev, info)
	if err != nil {
		return false, fmt.Errorf("record hermes %s: %w", ev.Kind, err)
	}
	if res.Stored {
		in.mu.Lock()
		in.stats.Events++
		if ev.Kind == event.KindTurnAssistant && ev.Tokens != nil && ev.Tokens.Total() > 0 && ev.CostUSD == nil {
			in.stats.Unpriced++
		}
		in.mu.Unlock()
	}
	return res.Stored, nil
}

// toolCwd is the folder a call ran in: a terminal call's own `workdir` when it
// named one, the session's otherwise.
func toolCwd(c ToolCall, cwd string) string {
	if w, ok := c.Input["workdir"].(string); ok && w != "" {
		return w
	}
	return cwd
}

// costMicros is the session's cost in millionths of a dollar, for a key.
func costMicros(s Session) int64 {
	usd, _, ok := s.Cost()
	if !ok {
		return -1
	}
	return int64(math.Round(usd * 1e6))
}
