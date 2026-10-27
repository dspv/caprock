package api

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// Compacting a session's context from Caprock (ADR-085; contract in
// 03-contracts.md § Compact context): Claude Code's own /compact, typed into
// a session Caprock started through its message queue, so the session goes
// on where it was with a summary in place of the conversation. Free.

// CompactCommand is what the Compact button types.
const CompactCommand = "/compact"

// CompactTypicalMin is how many measured compactions of this machine's own
// it takes before their median is shown; below it the figure is absent.
const CompactTypicalMin = 5

// compactRunningFor is how long after a PreCompact hook with no boundary
// since a compaction counts as still running. One that never wrote its
// boundary (the process was killed) stops counting after it.
const compactRunningFor = 10 * time.Minute

var (
	// ErrNotCompactable is a session whose agent is not Claude Code: the
	// boundary that measures a compaction is Claude Code's.
	ErrNotCompactable = errors.New("only a Claude Code session is compacted from Caprock")
	// ErrCompacting is a press while the session's compaction still runs.
	ErrCompacting = errors.New("this session is compacting its context already")
)

// CompactionView is GET /v1/sessions/{id}/compaction.
type CompactionView struct {
	SessionID string `json:"session_id"`
	// Last is the session's newest finished compaction, absent when it has
	// none recorded.
	Last *store.Compaction `json:"last,omitempty"`
	// Running is true from the PreCompact hook until the boundary it ends
	// with (at most compactRunningFor).
	Running bool `json:"running"`
	// Queued is true while a /compact waits in the session's message queue.
	Queued bool `json:"queued"`
	// Typical is what this machine's own compactions kept, absent with
	// fewer than CompactTypicalMin measured.
	Typical *store.CompactionStats `json:"typical,omitempty"`
}

// Compacter is the daemon's half of POST /v1/agents/{id}/compact: the
// queue, typing /compact in now or when the turn ends. Optional on the
// Queuer so test doubles need not grow a method.
type Compacter interface {
	Compact(ctx context.Context, sessionID string) (SendResult, error)
}

type compactStatsCache struct {
	mu sync.Mutex
	at time.Time
	v  store.CompactionStats
}

// typicalCompaction is the machine's compaction figure, measured at most
// once a minute.
func (s *Server) typicalCompaction(ctx context.Context) (store.CompactionStats, error) {
	c := &s.compactStats
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.at.IsZero() && time.Since(c.at) < time.Minute {
		return c.v, nil
	}
	v, err := store.RecentCompactionStats(ctx, s.d.Store.DB())
	if err != nil {
		return store.CompactionStats{}, err
	}
	c.v, c.at = v, time.Now()
	return v, nil
}

// compactionRunning reports whether the newest main-thread compaction event
// of a session is a PreCompact hook less than compactRunningFor old.
func compactionRunning(ctx context.Context, q store.Querier, id string, now time.Time) (bool, error) {
	evs, err := store.LastEventsFiltered(ctx, q, id, 1, store.EventFilter{MainOnly: true,
		Kinds: []string{string(event.KindContextCompact), string(event.KindContextCompacted)}})
	if err != nil || len(evs) == 0 {
		return false, err
	}
	e := evs[len(evs)-1]
	return e.Kind == event.KindContextCompact && e.Source == event.SourceHook && now.Sub(e.Ts) < compactRunningFor, nil
}

// handleCompaction is GET /v1/sessions/{id}/compaction.
func (s *Server) handleCompaction(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ctx := r.Context()
	db := s.d.Store.DB()
	v := CompactionView{SessionID: id}
	last, ok, err := store.LastCompaction(ctx, db, id)
	if err != nil {
		s.fail(w, err)
		return
	}
	if ok {
		v.Last = &last
	}
	if v.Running, err = compactionRunning(ctx, db, id, s.d.Now()); err != nil {
		s.fail(w, err)
		return
	}
	if s.d.Queue != nil {
		if qv, err := s.d.Queue.View(ctx, id); err == nil {
			for _, m := range qv.Messages {
				if m.Text == CompactCommand {
					v.Queued = true
				}
			}
		}
	}
	st, err := s.typicalCompaction(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	if st.Count >= CompactTypicalMin {
		v.Typical = &st
	}
	writeJSON(w, http.StatusOK, v)
}

// handleCompact is POST /v1/agents/{id}/compact: /compact typed into a
// session Caprock started, at once when it is at its prompt, otherwise when
// its turn ends. No body. 409 for a session Caprock did not start (rule 7),
// one that is not Claude Code, or one compacting already.
func (s *Server) handleCompact(w http.ResponseWriter, r *http.Request) {
	q, ok := s.queuer(w)
	if !ok {
		return
	}
	c, ok := q.(Compacter)
	if !ok {
		s.failCode(w, http.StatusNotImplemented, errors.New("this daemon cannot compact a session"))
		return
	}
	id := r.PathValue("id")
	if s.refuseShellToDevice(w, r, id) {
		return
	}
	running, err := compactionRunning(r.Context(), s.d.Store.DB(), id, s.d.Now())
	if err != nil {
		s.fail(w, err)
		return
	}
	if running {
		writeJSON(w, http.StatusConflict, map[string]string{"error": ErrCompacting.Error()})
		return
	}
	res, err := c.Compact(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrNotCompactable) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		s.queueFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}
