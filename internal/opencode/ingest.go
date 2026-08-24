package opencode

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

// Ingester copies OpenCode's sessions into Caprock's store.
//
// It polls rather than tails. OpenCode exposes an SSE stream that would give
// live events, but the first pass deliberately reads the database instead: a
// few seconds of latency on a cost figure is not worth delaying every screen
// for, and the database is the only source that also carries history from
// before Caprock was installed. The stream is a later addition, not a
// replacement — see .ai/16-opencode.md.
//
// Every write is idempotent. Events are keyed, and `(session_id, key)` is
// unique in the store, so a poll that re-reads rows it has already seen is a
// no-op rather than a duplicate.
type Ingester struct {
	db    *sql.DB
	rec   *rollup.Recorder
	log   *slog.Logger
	every time.Duration

	// seen remembers the last update time per session so a poll only reads
	// sessions that changed. Without it every tick re-reads all messages of
	// every session, which on a real database is tens of thousands of rows a
	// minute for no new information.
	seen map[string]int64

	stats Stats
}

// Stats is what the daemon reports about OpenCode ingest.
type Stats struct {
	Sessions int   `json:"sessions"`
	Events   int   `json:"events"`
	LastPoll int64 `json:"last_poll_ms,omitempty"`
}

// NewIngester builds an ingester over an already-open OpenCode database.
func NewIngester(db *sql.DB, rec *rollup.Recorder, log *slog.Logger, every time.Duration) *Ingester {
	if every <= 0 {
		every = 5 * time.Second
	}
	return &Ingester{db: db, rec: rec, log: log, every: every, seen: map[string]int64{}}
}

// Stats returns a snapshot of what has been ingested.
func (in *Ingester) Stats() Stats { return in.stats }

// Run polls until the context is cancelled.
//
// The first pass happens immediately so history is present on the first page
// load rather than one tick later.
func (in *Ingester) Run(ctx context.Context) error {
	t := time.NewTicker(in.every)
	defer t.Stop()
	for {
		if err := in.once(ctx); err != nil {
			// A failed poll is not fatal: OpenCode may be mid-write, or the
			// user may have deleted the database. Log and try again rather
			// than killing ingest for the rest of the daemon's life.
			in.log.Debug("opencode poll failed", "component", "opencode", "err", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// once reads everything that changed since the last poll.
func (in *Ingester) once(ctx context.Context) error {
	sessions, err := Sessions(ctx, in.db)
	if err != nil {
		return err
	}
	in.stats.LastPoll = time.Now().UnixMilli()

	for _, s := range sessions {
		if prev, ok := in.seen[s.ID]; ok && prev >= s.Updated {
			continue
		}
		if err := in.session(ctx, s); err != nil {
			// One unreadable session must not stop the rest.
			in.log.Debug("opencode session failed", "component", "opencode",
				"session", s.ID, "err", err)
			continue
		}
		in.seen[s.ID] = s.Updated
	}
	in.stats.Sessions = len(in.seen)
	return nil
}

// session imports one session and everything it contains.
func (in *Ingester) session(ctx context.Context, s Session) error {
	msgs, err := Messages(ctx, in.db, s.ID)
	if err != nil {
		return err
	}
	calls, err := ToolCalls(ctx, in.db, s.ID)
	if err != nil {
		return err
	}

	// Tool calls are grouped by the message that asked for them, which is what
	// links a tool call to the turn that paid for it. Caprock uses that link
	// for per-directory attribution, so it is established here rather than
	// reconstructed later.
	byMsg := map[string][]ToolCall{}
	for _, c := range calls {
		byMsg[c.MessageID] = append(byMsg[c.MessageID], c)
	}

	for _, m := range msgs {
		if m.Role == "assistant" {
			if err := in.turn(ctx, s, m); err != nil {
				return err
			}
		}
		for _, c := range byMsg[m.ID] {
			if err := in.tool(ctx, s, m, c); err != nil {
				return err
			}
		}
	}
	return nil
}

// info is the session identity carried alongside every event. The recorder
// creates or updates the session row from it, so there is no separate upsert.
func (in *Ingester) info(s Session) rollup.SessionInfo {
	return rollup.SessionInfo{Cwd: s.Directory, Model: s.Model, Agent: Agent}
}

// turn stores one assistant turn with the cost OpenCode already computed.
func (in *Ingester) turn(ctx context.Context, s Session, m Message) error {
	cost := m.Cost
	payload, _ := json.Marshal(map[string]any{
		"provider": m.Provider,
		"model":    m.Model,
		"cwd":      m.Cwd,
	})
	ev := &event.Event{
		Ts:        time.UnixMilli(m.Created),
		SessionID: s.ID,
		Source:    event.SourceOpenCode,
		Kind:      event.KindTurnAssistant,
		Model:     m.Model,
		Payload:   payload,
		// Keyed on OpenCode's own message id, which is stable across polls.
		// This is what makes re-reading a session idempotent.
		Key:   "oc-msg:" + m.ID,
		MsgID: m.ID,
		Tokens: &event.TokenDelta{
			In: m.TokensIn, Out: m.TokensOut,
			CacheRead: m.CacheRead, CacheWrite: m.CacheWrite,
		},
	}
	// Cost is OpenCode's figure, not ours. The pricing table is deliberately
	// not applied — two different arithmetics over the same tokens would
	// produce two different totals for the same session.
	if cost > 0 {
		ev.CostUSD = &cost
	}
	res, err := in.rec.Record(ctx, ev, in.info(s))
	if err != nil {
		return fmt.Errorf("record turn: %w", err)
	}
	if res.Stored {
		in.stats.Events++
	}
	return nil
}

// tool stores one tool call.
func (in *Ingester) tool(ctx context.Context, s Session, m Message, c ToolCall) error {
	// Shaped like a Claude Code hook payload rather than like OpenCode's own
	// row. Per-directory attribution derives touch_dir from the payload itself
	// (store.TouchDir) so that no writer can supply a hand-made value, and the
	// work-kind and narration code reads the same shape. Emitting OpenCode's
	// native field names here would leave every OpenCode tool call unplaced
	// and invisible to the directory breakdown.
	input := map[string]any{}
	if c.FilePath != "" {
		input["file_path"] = c.FilePath
	}
	payload, _ := json.Marshal(map[string]any{
		"tool_name":  c.Tool,
		"tool_input": input,
		"status":     c.Status,
		// The agent's own spelling, kept for anyone inspecting raw events.
		"opencode_tool": c.RawTool,
	})
	ts := c.Start
	if ts == 0 {
		ts = m.Created
	}
	ev := &event.Event{
		Ts:        time.UnixMilli(ts),
		SessionID: s.ID,
		Source:    event.SourceOpenCode,
		Kind:      event.KindToolPre,
		Tool:      c.Tool,
		Payload:   payload,
		Key:       "oc-tool:" + c.ID,
		// The message that requested the call. Equal ids mean "this tool call
		// was paid for by that turn", which is the linkage per-directory
		// attribution needs.
		MsgID: m.ID,
	}
	res, err := in.rec.Record(ctx, ev, in.info(s))
	if err != nil {
		return fmt.Errorf("record tool: %w", err)
	}
	if res.Stored {
		in.stats.Events++
	}
	return nil
}
