// Package rollup is the single write path for events: it stores the event,
// upserts the session, prices assistant turns, and maintains session_stats /
// daily_stats / session_files in one transaction, then publishes live frames.
// Every producer (hookd, ingest, harness) goes through Recorder.Record.
package rollup

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// SessionInfo is what a producer knows about the session an event belongs to.
// Empty fields are "unknown", never overwrite.
type SessionInfo struct {
	Cwd, TranscriptPath, GitBranch, Version, Model string
}

// Result reports what Record did, for callers that need to fan out further.
type Result struct {
	Stored   bool // false when the event was a duplicate
	Event    event.Event
	Session  store.Session
	Stats    store.Stats
	Priced   bool // cost computed for this event
	NewFiles int  // files touched for the first time by this event
}

// Recorder wires store + pricing + bus.
type Recorder struct {
	Store *store.Store
	Table *cost.Table
	Bus   *bus.Bus
	Log   *slog.Logger
	// Now is overridable in tests.
	Now func() time.Time
	// Location decides which calendar day a turn belongs to (daily_stats).
	Location *time.Location
}

// New builds a Recorder with sane defaults.
func New(st *store.Store, tb *cost.Table, b *bus.Bus, log *slog.Logger) *Recorder {
	if log == nil {
		log = slog.Default()
	}
	return &Recorder{Store: st, Table: tb, Bus: b, Log: log, Now: time.Now, Location: time.Local}
}

// Record stores one event and updates every rollup. It is safe to call from
// multiple goroutines; the store serializes writers.
func (r *Recorder) Record(ctx context.Context, ev *event.Event, info SessionInfo) (Result, error) {
	var res Result
	if ev.Ts.IsZero() {
		ev.Ts = r.Now()
	}
	if ev.Model == "" && info.Model != "" {
		ev.Model = info.Model
	}
	// Price before the tx so a pricing failure never rolls back an event.
	if ev.Kind == event.KindTurnAssistant && ev.Tokens != nil && ev.CostUSD == nil && r.Table != nil && ev.Model != "" {
		if usd, ok := r.Table.Price(ev.Model, *ev.Tokens); ok {
			ev.CostUSD = &usd
			res.Priced = true
		} else {
			r.Log.Warn("model not in pricing table; cost left unknown", "component", "rollup", "model", ev.Model, "session_id", ev.SessionID)
		}
	}

	err := r.Store.WithTx(ctx, func(q store.Querier) error {
		if _, err := store.InsertEvent(ctx, q, ev); err != nil {
			if errors.Is(err, store.ErrDuplicate) {
				return err
			}
			return err
		}
		res.Stored = true

		// Was this session known before? Drives the daily "sessions" count.
		prev, err := store.GetStats(ctx, q, ev.SessionID)
		if err != nil {
			return err
		}
		patch := store.SessionPatch{
			Cwd:            info.Cwd,
			Project:        store.ProjectFromCwd(info.Cwd),
			Model:          ev.Model,
			TranscriptPath: info.TranscriptPath,
			GitBranch:      info.GitBranch,
			Version:        info.Version,
			StartedAt:      ev.Ts.UnixMilli(),
			LastEventAt:    ev.Ts.UnixMilli(),
			FromHook:       ev.Source == event.SourceHook,
			FromTranscript: ev.Source == event.SourceTranscript,
		}
		if ev.Kind == event.KindAgentStop && ev.AgentID == "" {
			// A top-level Stop means the turn ended, not the session; the session
			// goes idle via the idle sweeper, and 'ended' only on SessionEnd/kill.
			patch.Status = ""
		}
		if err := store.UpsertSession(ctx, q, ev.SessionID, patch); err != nil {
			return err
		}

		delta := store.Stats{SessionID: ev.SessionID}
		switch ev.Kind {
		case event.KindTurnAssistant:
			delta.Turns = 1
			if ev.Tokens != nil {
				delta.TokensIn, delta.TokensOut, delta.CacheRead, delta.CacheWrite = ev.Tokens.In, ev.Tokens.Out, ev.Tokens.CacheRead, ev.Tokens.CacheWrite
			}
			if ev.CostUSD != nil {
				delta.CostUSD = *ev.CostUSD
			}
		case event.KindToolPre:
			delta.ToolCalls = 1
			if p := touchedPath(ev); p != "" {
				isNew, err := store.TouchFile(ctx, q, ev.SessionID, p, ev.Ts.UnixMilli())
				if err != nil {
					return err
				}
				if isNew {
					delta.FilesTouched = 1
					res.NewFiles = 1
				}
			}
		}
		st, err := store.AddStats(ctx, q, delta)
		if err != nil {
			return err
		}
		res.Stats = st

		if ev.Kind == event.KindTurnAssistant {
			day := ev.Ts.In(r.Location).Format("2006-01-02")
			var tokens int64
			if ev.Tokens != nil {
				tokens = ev.Tokens.Total()
			}
			var usd float64
			if ev.CostUSD != nil {
				usd = *ev.CostUSD
			}
			project := store.ProjectFromCwd(info.Cwd)
			if project == "" {
				if s, err := store.GetSession(ctx, q, ev.SessionID); err == nil {
					project = s.Project
				}
			}
			if err := store.AddDaily(ctx, q, day, project, ev.Model, tokens, usd, prev.Turns == 0); err != nil {
				return err
			}
		}
		s, err := store.GetSession(ctx, q, ev.SessionID)
		if err != nil {
			return err
		}
		res.Session = s
		return nil
	})
	if errors.Is(err, store.ErrDuplicate) {
		res.Stored = false
		return res, nil
	}
	if err != nil {
		return res, err
	}
	res.Event = *ev
	if r.Bus != nil {
		r.Bus.Publish(bus.Frame{Type: bus.FrameEvent, Data: res.Event})
		r.Bus.Publish(bus.Frame{Type: bus.FrameSession, Data: SessionFrame{Session: res.Session, Stats: res.Stats}})
	}
	return res, nil
}

// SessionFrame is the payload of a "session" live frame.
type SessionFrame struct {
	Session store.Session `json:"session"`
	Stats   store.Stats   `json:"stats"`
}

// touchedPath extracts the file path a tool call edits, for Edit/Write/MultiEdit/NotebookEdit.
func touchedPath(ev *event.Event) string {
	switch ev.Tool {
	case "Edit", "Write", "MultiEdit", "NotebookEdit":
	default:
		return ""
	}
	var p struct {
		ToolInput struct {
			FilePath     string `json:"file_path"`
			NotebookPath string `json:"notebook_path"`
		} `json:"tool_input"`
	}
	if err := json.Unmarshal(ev.Payload, &p); err != nil {
		return ""
	}
	path := p.ToolInput.FilePath
	if path == "" {
		path = p.ToolInput.NotebookPath
	}
	return strings.TrimSpace(path)
}

// MarkIdle flips sessions silent for longer than idleAfter to idle, and sessions
// silent for longer than endAfter (when > 0) to ended, publishing their new
// state. Called periodically by the daemon.
func (r *Recorder) MarkIdle(ctx context.Context, idleAfter, endAfter time.Duration) error {
	before := r.Now().Add(-idleAfter).UnixMilli()
	var ids []string
	err := r.Store.WithTx(ctx, func(q store.Querier) error {
		var err error
		ids, err = store.MarkIdleSessions(ctx, q, before)
		if err != nil {
			return err
		}
		if endAfter > 0 {
			ended, err := store.MarkEndedSessions(ctx, q, r.Now().Add(-endAfter).UnixMilli())
			if err != nil {
				return err
			}
			ids = append(ids, ended...)
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, id := range ids {
		s, err := store.GetSession(ctx, r.Store.DB(), id)
		if err != nil {
			continue
		}
		st, _ := store.GetStats(ctx, r.Store.DB(), id)
		if r.Bus != nil {
			r.Bus.Publish(bus.Frame{Type: bus.FrameSession, Data: SessionFrame{Session: s, Stats: st}})
		}
	}
	return nil
}
