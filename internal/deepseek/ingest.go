package deepseek

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

// Ingester copies DSH session transcripts into Caprock's store.
//
// It polls rather than watches, exactly like Codex's importer. The transcripts
// are append-only and every event carries a key derived from its record seq, so
// a re-read of an already-seen file costs a read and produces nothing:
// `(session_id, key)` is unique in the store. Only files whose modification
// time or size moved are re-read.
type Ingester struct {
	dir   string
	rec   *rollup.Recorder
	log   *slog.Logger
	every time.Duration

	mu    sync.Mutex
	seen  map[string]fileState
	stats Stats
}

type fileState struct {
	mod  time.Time
	size int64
}

// Stats is what the daemon reports about DSH ingest.
type Stats struct {
	Sessions int   `json:"sessions"`
	Events   int   `json:"events"`
	Unpriced int   `json:"unpriced,omitempty"`
	LastPoll int64 `json:"last_poll_ms,omitempty"`
}

// NewIngester builds an ingester over a DSH sessions directory.
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

// Run polls until the context is cancelled, importing once immediately so a
// fresh daemon shows history straight away rather than after the first tick.
func (in *Ingester) Run(ctx context.Context) error {
	t := time.NewTicker(in.every)
	defer t.Stop()
	if err := in.once(ctx); err != nil && ctx.Err() == nil {
		in.log.Warn("deepseek import failed", "component", "deepseek", "err", err)
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			if err := in.once(ctx); err != nil && ctx.Err() == nil {
				in.log.Warn("deepseek import failed", "component", "deepseek", "err", err)
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
			continue
		}
		s, err := ParseFile(f.Path)
		if err != nil {
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
		in.stats.Sessions = len(in.seen)
		in.mu.Unlock()
	}
	in.mu.Lock()
	in.stats.LastPoll = time.Now().UnixMilli()
	in.mu.Unlock()
	return nil
}

// session records one parsed transcript: its turns, tool calls and user
// prompts, in the order they happened.
func (in *Ingester) session(ctx context.Context, s *Session) error {
	info := rollup.SessionInfo{Cwd: s.Cwd, Model: s.Model, Agent: Agent}

	type item struct {
		at   time.Time
		turn *Turn
		tool *ToolCall
		user *UserMsg
	}
	items := make([]item, 0, len(s.Turns)+len(s.Tools)+len(s.Users))
	for i := range s.Turns {
		items = append(items, item{at: s.Turns[i].At, turn: &s.Turns[i]})
	}
	for i := range s.Tools {
		items = append(items, item{at: s.Tools[i].At, tool: &s.Tools[i]})
	}
	for i := range s.Users {
		items = append(items, item{at: s.Users[i].At, user: &s.Users[i]})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].at.Before(items[j].at) })

	for _, it := range items {
		var err error
		switch {
		case it.turn != nil:
			err = in.turn(ctx, s, *it.turn, info)
		case it.tool != nil:
			err = in.tool(ctx, s, *it.tool, info)
		case it.user != nil:
			err = in.user(ctx, s, *it.user, info)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// turn stores one assistant turn. DSH reports no cost of its own, only tokens,
// so the recorder prices it from Caprock's table — the same as Codex and Gemini.
func (in *Ingester) turn(ctx context.Context, s *Session, t Turn, info rollup.SessionInfo) error {
	model := t.Model
	if model == "" {
		model = s.Model
	}
	payload, _ := json.Marshal(map[string]any{
		"model":            model,
		"cwd":              s.Cwd,
		"text":             t.Text,
		"reasoning_tokens": t.Reasoning,
	})
	ev := &event.Event{
		Ts:        t.At,
		SessionID: s.ID,
		Source:    event.SourceDeepseek,
		Kind:      event.KindTurnAssistant,
		Model:     model,
		Payload:   payload,
		Key:       t.Key,
		Tokens: &event.TokenDelta{
			In: t.In, Out: t.Out,
			CacheRead: t.CacheRead, CacheWrite: t.CacheWrite,
		},
	}
	res, err := in.rec.Record(ctx, ev, info)
	if err != nil {
		return fmt.Errorf("record deepseek turn: %w", err)
	}
	if res.Stored {
		in.mu.Lock()
		in.stats.Events++
		if model == "" {
			in.stats.Unpriced++
		}
		in.mu.Unlock()
	}
	return nil
}

// tool stores one tool call, shaped like a Claude Code hook payload so the
// per-directory attribution and narration read the same shape as every other
// agent's tool calls.
func (in *Ingester) tool(ctx context.Context, s *Session, c ToolCall, info rollup.SessionInfo) error {
	payload, _ := json.Marshal(map[string]any{
		"tool_name":  c.Name,
		"tool_input": toolInput(c.Input),
	})
	ev := &event.Event{
		Ts:        c.At,
		SessionID: s.ID,
		Source:    event.SourceDeepseek,
		Kind:      event.KindToolPre,
		Tool:      c.Name,
		Payload:   payload,
		Key:       c.Key,
	}
	res, err := in.rec.Record(ctx, ev, info)
	if err != nil {
		return fmt.Errorf("record deepseek tool: %w", err)
	}
	if res.Stored {
		in.mu.Lock()
		in.stats.Events++
		in.mu.Unlock()
	}
	return nil
}

// user stores one user prompt so the Answers screen can search what was asked.
func (in *Ingester) user(ctx context.Context, s *Session, u UserMsg, info rollup.SessionInfo) error {
	payload, _ := json.Marshal(map[string]any{"text": u.Text})
	ev := &event.Event{
		Ts:        u.At,
		SessionID: s.ID,
		Source:    event.SourceDeepseek,
		Kind:      event.KindTurnUser,
		Payload:   payload,
		Key:       u.Key,
	}
	res, err := in.rec.Record(ctx, ev, info)
	if err != nil {
		return fmt.Errorf("record deepseek user message: %w", err)
	}
	if res.Stored {
		in.mu.Lock()
		in.stats.Events++
		in.mu.Unlock()
	}
	return nil
}

// toolInput normalises a call's arguments to an object. DSH records them as a
// JSON string; downstream code reads tool_input as an object, so a string that
// is not JSON is wrapped under `command` — the shape every shell call takes.
func toolInput(raw string) any {
	if raw == "" {
		return map[string]any{}
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(raw), &obj); err == nil {
		return obj
	}
	return map[string]any{"command": raw}
}
