package codex

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

// Agent is the value written to sessions.agent for Codex sessions.
const Agent = "codex"

// Ingester copies Codex's rollout transcripts into Caprock's store.
//
// It polls rather than watches. The transcripts are append-only files, so a
// poll that re-reads one it has already seen costs a read and produces nothing:
// every event carries a key derived from the record's ordinal, and
// `(session_id, key)` is unique in the store.
//
// Only files whose modification time moved are re-read, which on a machine with
// a hundred transcripts is one stat per file per tick and no parsing at all.
type Ingester struct {
	dir   string
	rec   *rollup.Recorder
	log   *slog.Logger
	every time.Duration

	// seen remembers each transcript's last modification time and size, so a
	// tick only re-reads what changed. Both are compared because a file
	// rewritten within the same second still changes length.
	mu    sync.Mutex
	seen  map[string]fileState
	stats Stats
}

type fileState struct {
	mod  time.Time
	size int64
}

// Stats is what the daemon reports about Codex ingest.
type Stats struct {
	Sessions int `json:"sessions"`
	Events   int `json:"events"`
	Unpriced int `json:"unpriced,omitempty"`
	// Repriced counts turns that were stored before the model could be read
	// and have since been given one from their transcript.
	Repriced int   `json:"repriced,omitempty"`
	LastPoll int64 `json:"last_poll_ms,omitempty"`
}

// NewIngester builds an ingester over a Codex transcript directory.
func NewIngester(dir string, rec *rollup.Recorder, log *slog.Logger, every time.Duration) *Ingester {
	if every <= 0 {
		every = 5 * time.Second
	}
	return &Ingester{dir: dir, rec: rec, log: log, every: every, seen: map[string]fileState{}}
}

// Stats returns a snapshot of what has been imported.
func (in *Ingester) Stats() Stats {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.stats
}

// Run polls until the context is cancelled. It imports once immediately so a
// fresh daemon shows history straight away rather than after the first tick.
func (in *Ingester) Run(ctx context.Context) error {
	t := time.NewTicker(in.every)
	defer t.Stop()
	if err := in.once(ctx); err != nil && ctx.Err() == nil {
		in.log.Warn("codex import failed", "component", "codex", "err", err)
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			if err := in.once(ctx); err != nil && ctx.Err() == nil {
				in.log.Warn("codex import failed", "component", "codex", "err", err)
			}
		}
	}
}

// once imports every transcript that changed since the last pass.
func (in *Ingester) once(ctx context.Context) error {
	files, err := List(in.dir)
	if err != nil {
		return err
	}
	for _, f := range files {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		in.mu.Lock()
		prev, ok := in.seen[f.Path]
		in.mu.Unlock()
		if ok && prev.mod.Equal(f.Modified) && prev.size == f.Size {
			continue // unchanged since the last pass
		}
		s, err := ParseFile(f.Path)
		if err != nil {
			// A file that is not a transcript, or is unreadable, is skipped
			// and remembered so it is not retried every tick. A transcript
			// being written right now parses fine — Parse tolerates a partial
			// final line — so this is a genuinely broken file, not a live one.
			in.mu.Lock()
			in.seen[f.Path] = fileState{mod: f.Modified, size: f.Size}
			in.mu.Unlock()
			continue
		}
		if err := in.session(ctx, s); err != nil {
			return err
		}
		in.mu.Lock()
		in.seen[f.Path] = fileState{mod: f.Modified, size: f.Size}
		// Updated inside the loop, not after it. The first pass over a real
		// machine's hundred transcripts takes seconds, and `caprock status`
		// read during it reported "0 transcripts read" beside a rising event
		// count — a progress figure that only appears once there is no longer
		// any progress to report.
		in.stats.Sessions = len(in.seen)
		in.mu.Unlock()
	}
	in.mu.Lock()
	in.stats.LastPoll = time.Now().UnixMilli()
	in.mu.Unlock()
	return nil
}

// session records one parsed transcript: its turns and its tool calls, in the
// order they happened.
func (in *Ingester) session(ctx context.Context, s *Session) error {
	info := rollup.SessionInfo{Cwd: s.Cwd, Model: s.Model, Version: s.CLIVersion, Agent: Agent}

	// Turns and tools are interleaved by time so the session's event stream
	// reads the way it happened, rather than as all turns followed by all
	// tools. The dashboard's narration walks this order.
	type item struct {
		at   time.Time
		turn *Turn
		tool *ToolCall
	}
	items := make([]item, 0, len(s.Turns)+len(s.Tools))
	for i := range s.Turns {
		items = append(items, item{at: s.Turns[i].At, turn: &s.Turns[i]})
	}
	for i := range s.Tools {
		items = append(items, item{at: s.Tools[i].At, tool: &s.Tools[i]})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].at.Before(items[j].at) })

	for _, it := range items {
		var err error
		switch {
		case it.turn != nil:
			err = in.turn(ctx, s, *it.turn, info)
		case it.tool != nil:
			err = in.tool(ctx, s, *it.tool, info)
		}
		if err != nil {
			return err
		}
	}
	// Rows written before this importer could find the model are corrected
	// here, from the transcript they came from. Best-effort: a failure to
	// repair history must not stop the import of what is current.
	if err := in.repriceSession(ctx, s); err != nil {
		in.log.Debug("codex reprice failed", "component", "codex", "session_id", s.ID, "err", err)
	}
	return nil
}

// turn stores one assistant turn.
//
// Unlike OpenCode, Codex reports no cost of its own — only token counts — so
// the cost is left for the recorder to compute from the pricing table. When the
// transcript never named a model there is nothing to price against, and the
// turn is stored with its real tokens and no cost rather than with a guessed
// one: rule 6 prefers a missing number to an invented one. This is common, not
// exceptional — most Codex Desktop transcripts carry no `turn_context` at all.
func (in *Ingester) turn(ctx context.Context, s *Session, t Turn, info rollup.SessionInfo) error {
	fields := map[string]any{
		"model":      s.Model,
		"cwd":        s.Cwd,
		"originator": s.Originator,
		"reasoning":  t.Reasoning,
	}
	if t.TotalOnly {
		// Recorded so the figure can be traced later: this turn's transcript
		// gave a total with no breakdown, so its whole usage is counted as
		// input and its cost is an upper bound.
		fields["tokens_total_only"] = true
	}
	payload, _ := json.Marshal(fields)
	ev := &event.Event{
		Ts:        t.At,
		SessionID: s.ID,
		Source:    event.SourceCodex,
		Kind:      event.KindTurnAssistant,
		Model:     s.Model,
		Payload:   payload,
		Key:       t.Key,
		// Codex's `input_tokens` is the TOTAL prompt, with `cached_input_tokens`
		// a subset of it — verified on all 239 token samples in 100 real
		// transcripts, where input+output always equals the reported total.
		// Caprock's TokenDelta.In means *fresh* input, billed separately from
		// CacheRead, so the cached part has to come out: passing Codex's figure
		// straight through bills every cached token twice, once at full price.
		Tokens: &event.TokenDelta{
			In: fresh(t.In, t.CacheRead), Out: t.Out,
			CacheRead: t.CacheRead, CacheWrite: t.CacheWrite,
		},
	}
	res, err := in.rec.Record(ctx, ev, info)
	if err != nil {
		return fmt.Errorf("record codex turn: %w", err)
	}
	if res.Stored {
		in.mu.Lock()
		in.stats.Events++
		if s.Model == "" {
			in.stats.Unpriced++
		}
		in.mu.Unlock()
	}
	return nil
}

// fresh is the uncached part of a prompt: Codex counts cached tokens inside its
// input total, Caprock counts them beside it. Clamped at zero because a cached
// count larger than the input it belongs to has never been observed and would
// otherwise produce a negative charge.
func fresh(in, cacheRead int64) int64 {
	if n := in - cacheRead; n > 0 {
		return n
	}
	return 0
}

// tool stores one tool call.
//
// Shaped like a Claude Code hook payload rather than like Codex's own record,
// for the same reason OpenCode's is: per-directory attribution derives
// touch_dir from the payload itself, and the work-kind and narration code reads
// that one shape. A second shape here would mean a second implementation of
// everything downstream.
func (in *Ingester) tool(ctx context.Context, s *Session, c ToolCall, info rollup.SessionInfo) error {
	payload, _ := json.Marshal(map[string]any{
		"session_id": s.ID,
		"cwd":        s.Cwd,
		"tool_name":  c.Name,
		"tool_input": toolInput(c),
	})
	ev := &event.Event{
		Ts:        c.At,
		SessionID: s.ID,
		Source:    event.SourceCodex,
		Kind:      event.KindToolPre,
		Tool:      c.Name,
		Payload:   payload,
		Key:       c.Key,
	}
	res, err := in.rec.Record(ctx, ev, info)
	if err != nil {
		return fmt.Errorf("record codex tool: %w", err)
	}
	if res.Stored {
		in.mu.Lock()
		in.stats.Events++
		in.mu.Unlock()
	}
	return nil
}

// toolInput normalises a call's arguments to an object.
//
// Codex spells them two ways: a `custom_tool_call` carries a JSON string of
// JavaScript, a `function_call` carries a JSON object. Downstream code reads
// `tool_input` as an object, so a string is wrapped under `command` — which is
// what it is in every observed case (`shell`, `exec`).
func toolInput(c ToolCall) any {
	raw := c.Input
	if raw == "" {
		return map[string]any{}
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(raw), &obj); err == nil {
		return obj
	}
	var str string
	if err := json.Unmarshal([]byte(raw), &str); err == nil {
		return map[string]any{"command": str}
	}
	return map[string]any{"command": raw}
}

// repriceSession fills in the model on turns already stored without one, and
// prices them.
//
// It exists because the first release of this importer read the model from
// `turn_context` alone, which 96 of 100 real transcripts do not carry — so
// those turns were stored with real tokens and no model, and no cost. Reading
// the second source fixes every *future* import and reaches none of the rows
// already written: event keys are idempotent by design, so a re-read is a
// no-op rather than a correction.
//
// A migration could not do this. `events.payload` is stored verbatim and the
// answer can normally be read back out of it — that is how the /clear
// reclassification worked — but here the payload records `"model": ""`,
// because the model was never captured. The transcripts on disk are the only
// place the answer exists.
//
// It invents nothing: it reads the same file the row came from, and touches
// only rows of ours that have no model at all. A turn that already names one
// is left alone, whatever it says.
func (in *Ingester) repriceSession(ctx context.Context, s *Session) error {
	if s.Model == "" || in.rec == nil || in.rec.Table == nil {
		return nil
	}
	db := in.rec.Store.DB()
	rows, err := db.QueryContext(ctx,
		`SELECT id, ts, tokens_in, tokens_out, cache_read, cache_write
		   FROM events
		  WHERE session_id = ? AND source = ? AND kind = ?
		    AND COALESCE(model, '') = ''`,
		s.ID, string(event.SourceCodex), string(event.KindTurnAssistant))
	if err != nil {
		return err
	}
	type row struct {
		id     int64
		ts     int64
		tokens event.TokenDelta
	}
	var todo []row
	for rows.Next() {
		var r row
		var in64, out64, cr, cw sql.NullInt64
		if err := rows.Scan(&r.id, &r.ts, &in64, &out64, &cr, &cw); err != nil {
			_ = rows.Close()
			return err
		}
		r.tokens = event.TokenDelta{In: in64.Int64, Out: out64.Int64, CacheRead: cr.Int64, CacheWrite: cw.Int64}
		todo = append(todo, r)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(todo) == 0 {
		return nil
	}
	for _, r := range todo {
		// Priced at the turn's own timestamp, like every other turn: a price
		// that has since changed was the real one for the work that ran under
		// it.
		usd, ok := in.rec.Table.PriceAt(s.Model, r.tokens, time.UnixMilli(r.ts))
		if !ok {
			continue
		}
		if _, err := db.ExecContext(ctx,
			`UPDATE events SET model = ?, cost_usd = ? WHERE id = ? AND COALESCE(model,'') = ''`,
			s.Model, usd, r.id); err != nil {
			return err
		}
	}
	in.mu.Lock()
	in.stats.Repriced += len(todo)
	in.mu.Unlock()
	in.log.Info("codex turns repriced from the transcript",
		"component", "codex", "session_id", s.ID, "model", s.Model, "turns", len(todo))
	return nil
}
