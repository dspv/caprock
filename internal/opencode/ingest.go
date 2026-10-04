package opencode

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/sessionlink"
	"github.com/dspv/caprock/internal/store"
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
	//
	// Guarded because the live stream writes to it from its own goroutine:
	// Touch and the poll loop both record what they have read.
	mu    sync.Mutex
	seen  map[string]int64
	stats Stats

	// One import at a time. The poll loop and the live stream both write, and
	// two concurrent writers make SQLite refuse one of them — which surfaced
	// as the daemon's own sweeps failing with SQLITE_BUSY, not as a failure in
	// the importer that caused it.
	writing sync.Mutex

	// Link files a session under the Caprock session that started it, when
	// Caprock did (see internal/sessionlink). Nil leaves every session under
	// OpenCode's own id.
	Link *sessionlink.Linker
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

// Touch re-reads one session immediately, out of turn.
//
// This is what the live stream calls: an event says a session changed, and the
// figures still come from the database rather than from the event, because the
// database is the only place OpenCode's own cost arithmetic lives. Reading the
// event's payload instead would mean maintaining a second understanding of
// their schema that drifts from the first.
func (in *Ingester) Touch(ctx context.Context, sessionID string) {
	in.writing.Lock()
	defer in.writing.Unlock()

	s, ok, err := SessionByID(ctx, in.db, sessionID)
	if err != nil || !ok {
		if err != nil {
			in.log.Debug("opencode touch failed", "component", "opencode", "err", err)
		}
		return
	}
	{
		if err := in.session(ctx, s); err != nil {
			in.log.Debug("opencode touch failed", "component", "opencode",
				"session", sessionID, "err", err)
			return
		}
		// Record what the poll loop would have recorded, so its change
		// detection does not read this session again on the next tick.
		in.mu.Lock()
		in.seen[s.ID] = s.Updated
		in.stats.Sessions = len(in.seen)
		in.mu.Unlock()
		return
	}
}

// Stats returns a snapshot of what has been ingested.
func (in *Ingester) Stats() Stats {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.stats
}

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
	in.writing.Lock()
	defer in.writing.Unlock()

	sessions, err := Sessions(ctx, in.db)
	if err != nil {
		return err
	}
	in.stats.LastPoll = time.Now().UnixMilli()

	for _, s := range sessions {
		in.mu.Lock()
		prev, ok := in.seen[s.ID]
		in.mu.Unlock()
		if ok && prev >= s.Updated {
			continue
		}
		if err := in.session(ctx, s); err != nil {
			// One unreadable session must not stop the rest.
			in.log.Debug("opencode session failed", "component", "opencode",
				"session", s.ID, "err", err)
			continue
		}
		in.mu.Lock()
		in.seen[s.ID] = s.Updated
		in.stats.Sessions = len(in.seen)
		in.mu.Unlock()
	}
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
	parts, err := TextParts(ctx, in.db, s.ID)
	if err != nil {
		return err
	}
	texts := joinTexts(parts)
	// The id the session's rows are stored under: the Caprock session that
	// started it, or OpenCode's own. OpenCode's id is still what its own
	// database is queried by.
	sid := in.storeID(ctx, s)

	// Tool calls are grouped by the message that asked for them, which is what
	// links a tool call to the turn that paid for it. Caprock uses that link
	// for per-directory attribution, so it is established here rather than
	// reconstructed later.
	byMsg := map[string][]ToolCall{}
	for _, c := range calls {
		byMsg[c.MessageID] = append(byMsg[c.MessageID], c)
	}

	for _, m := range msgs {
		switch m.Role {
		case "assistant":
			if err := in.turn(ctx, sid, s, m, texts[m.ID]); err != nil {
				return err
			}
		case "user":
			if err := in.prompt(ctx, sid, s, m, PromptText(parts[m.ID])); err != nil {
				return err
			}
		}
		for _, c := range byMsg[m.ID] {
			if err := in.tool(ctx, sid, s, m, c); err != nil {
				return err
			}
		}
	}
	if err := in.refreshText(ctx, sid, s, msgs, texts); err != nil {
		return err
	}
	// The title reaches the row through SessionInfo only when an event is
	// stored, and a session already imported stores none — so a session read
	// before titles were kept, or renamed since, would never get its name.
	// Written directly, after the events, so the row exists.
	if in.rec != nil && in.rec.Store != nil {
		if err := store.SetTitle(ctx, in.rec.Store.DB(), sid, sessionTitle(s.Title)); err != nil {
			return err
		}
	}
	return nil
}

// storeID is the session OpenCode's session is stored under. Links are made
// exactly, from the TUI's own server (sessionlink.Linker.Claim), so this only
// looks one up and never matches.
func (in *Ingester) storeID(ctx context.Context, s Session) string {
	if in.Link == nil || s.IsChild() {
		return s.ID
	}
	return in.Link.Resolve(ctx, Agent, sessionlink.Candidate{NativeID: s.ID})
}

// info is the session identity carried alongside every event. The recorder
// creates or updates the session row from it, so there is no separate upsert.
func (in *Ingester) info(s Session) rollup.SessionInfo {
	return rollup.SessionInfo{Cwd: s.Directory, Model: s.Model, Agent: Agent, Title: sessionTitle(s.Title)}
}

// turn stores one assistant turn with the cost OpenCode already computed, and
// the prose it wrote.
//
// `text` and `sidechain` are the two fields the Memory screen reads, in the
// shape the Claude Code parser writes them, so the notes query stays
// source-agnostic. A subagent's words live in a child session in OpenCode
// rather than in a sidechain of the parent, but they are the same thing: marked
// sidechain, they stay out of "what did the agent say" exactly as a Claude Code
// subagent's do.
func (in *Ingester) turn(ctx context.Context, sid string, s Session, m Message, text string) error {
	cost := m.Cost
	payload, _ := json.Marshal(map[string]any{
		"provider":  m.Provider,
		"model":     m.Model,
		"cwd":       m.Cwd,
		"text":      text,
		"sidechain": s.IsChild(),
	})
	ev := &event.Event{
		Ts:        time.UnixMilli(m.Created),
		SessionID: sid,
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
		in.mu.Lock()
		in.stats.Events++
		in.mu.Unlock()
	}
	return nil
}

// prompt stores what the person typed in one user message as `turn.user`.
//
// The payload is a Claude Code prompt's shape — `prompt`, `cwd` — because
// every reader of a prompt already reads that: the notes search (a reply is
// found by the question asked), a session's description and search, and the
// timeline. A child session's prompt is the task its parent agent wrote, not
// the person's words; it is kept, as a Claude Code subagent's is, and marked
// `sidechain` the way the child's replies are.
//
// Keyed on OpenCode's message id, so it is stored once whichever pass reads
// it first — and the first pass after a start, which reads every session, is
// the backfill for prompts of sessions imported before they were read: it
// inserts the ones missing and finds the rest already there. A user message
// read before its text part was written stores nothing yet; the next read of
// the session — the reply that follows moves its update time — stores it.
func (in *Ingester) prompt(ctx context.Context, sid string, s Session, m Message, text string) error {
	if text == "" {
		return nil
	}
	payload, _ := json.Marshal(map[string]any{
		"prompt":    text,
		"cwd":       s.Directory,
		"sidechain": s.IsChild(),
	})
	ev := &event.Event{
		Ts:        time.UnixMilli(m.Created),
		SessionID: sid,
		Source:    event.SourceOpenCode,
		Kind:      event.KindTurnUser,
		Payload:   payload,
		Key:       "oc-user:" + m.ID,
	}
	res, err := in.rec.Record(ctx, ev, in.info(s))
	if err != nil {
		return fmt.Errorf("record prompt: %w", err)
	}
	if res.Stored {
		in.mu.Lock()
		in.stats.Events++
		in.mu.Unlock()
	}
	return nil
}

// refreshText brings the prose of turns already stored up to date.
//
// A turn is stored once — `(session_id, key)` is unique and a re-read inserts
// nothing — so without this two kinds of row would keep an empty or partial
// `text` for good: every turn imported before the importer read text parts,
// and a turn the poller or the live stream caught while OpenCode was still
// writing its reply (the message row exists before its text parts finish).
// Both are mended here, on the next read of the session. The poller re-reads
// every session on its first pass after a start, so that pass is also the
// backfill for history: it runs in the poller's own goroutine, never holds up
// startup, and a failure costs only this session's text until the next read.
//
// Only `text` and `sidechain` are rewritten, via json_set, and only on rows
// whose value differs: every other payload key, the event id, tokens and cost
// are untouched, and a session already in step costs one read and no write.
func (in *Ingester) refreshText(ctx context.Context, sid string, s Session, msgs []Message, texts map[string]string) error {
	if in.rec == nil || in.rec.Store == nil {
		return nil
	}
	db := in.rec.Store.DB()
	rows, err := db.QueryContext(ctx, `
		SELECT msg_id, COALESCE(json_extract(payload,'$.text'),''),
		       COALESCE(json_extract(payload,'$.sidechain'),0)
		FROM events
		WHERE session_id = ? AND source = ? AND kind = 'turn.assistant'
		  AND msg_id IS NOT NULL AND json_valid(payload)`,
		sid, string(event.SourceOpenCode))
	if err != nil {
		return fmt.Errorf("read stored text: %w", err)
	}
	type stored struct {
		text      string
		sidechain bool
	}
	have := map[string]stored{}
	for rows.Next() {
		var id, text string
		var side int
		if err := rows.Scan(&id, &text, &side); err != nil {
			_ = rows.Close()
			return err
		}
		have[id] = stored{text: text, sidechain: side == 1}
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	side := "false"
	if s.IsChild() {
		side = "true"
	}
	type fix struct{ id, text string }
	var fixes []fix
	for _, m := range msgs {
		if m.Role != "assistant" {
			continue
		}
		cur, ok := have[m.ID]
		if !ok {
			continue // not stored (or just stored with the current text)
		}
		if cur.text == texts[m.ID] && cur.sidechain == s.IsChild() {
			continue
		}
		fixes = append(fixes, fix{id: m.ID, text: texts[m.ID]})
	}
	if len(fixes) == 0 {
		return nil
	}
	return in.rec.Store.WithTx(ctx, func(q store.Querier) error {
		for _, f := range fixes {
			if _, err := q.ExecContext(ctx, `
				UPDATE events
				SET payload = json_set(payload, '$.text', ?, '$.sidechain', json(?))
				WHERE session_id = ? AND key = ? AND json_valid(payload)`,
				f.text, side, sid, "oc-msg:"+f.id); err != nil {
				return fmt.Errorf("refresh text: %w", err)
			}
		}
		return nil
	})
}

// tool stores one tool call.
func (in *Ingester) tool(ctx context.Context, sid string, s Session, m Message, c ToolCall) error {
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
		SessionID: sid,
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
		in.mu.Lock()
		in.stats.Events++
		in.mu.Unlock()
	}
	return nil
}

// sessionTitle is OpenCode's name for a session, or "" while it still carries
// the placeholder OpenCode gives every session before it names one — "New
// session - 2026-09-12T…" would make every untitled card read the same, which
// is the problem the title exists to solve.
func sessionTitle(t string) string {
	t = strings.TrimSpace(t)
	if strings.HasPrefix(t, "New session - ") || strings.HasPrefix(t, "Child session - ") {
		return ""
	}
	return t
}
