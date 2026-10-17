package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/brain"
	"github.com/dspv/caprock/internal/store"
)

// AI;DR (ADR-072; contract in 03-contracts.md § AI;DR): the button under an
// agent answer that squeezes it into at most two short sentences. The squeeze
// is a separate headless call to the user's own claude — Second Brain's
// runner, its cheapest model, the answer on stdin, no session written — made
// only on the tap, never typed into the session, and kept (event_tldr) so a
// second tap makes no call. Allowed for a controller phone as for the machine:
// it reads an answer the phone already shows and writes only Caprock's cache.

// tldrTimeout bounds one squeeze, whoever is waiting on it.
const tldrTimeout = 60 * time.Second

// tldrCall is one squeeze in flight; every tap on the same answer while it
// runs waits on it instead of making a second call.
type tldrCall struct {
	done chan struct{}
	res  brain.TLDR
	err  error
}

// tldrFlights holds the squeezes in flight, by event id.
type tldrFlights struct {
	mu    sync.Mutex
	calls map[int64]*tldrCall
}

// TLDRResponse is POST /v1/events/{id}/tldr.
type TLDRResponse struct {
	TLDR   string `json:"tldr"`
	Cached bool   `json:"cached"`
}

func (s *Server) handleEventTLDR(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such answer"})
		return
	}
	db := s.d.Store.DB()
	_, text, err := store.BrainNoteSource(ctx, db, id)
	if errors.Is(err, store.ErrBrainNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "that event is not an answer an agent wrote in a session's main thread"})
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	// A short answer is its own TL;DR: no call, nothing kept.
	if brain.TLDRShort(text) {
		writeJSON(w, http.StatusOK, TLDRResponse{TLDR: strings.TrimSpace(text)})
		return
	}
	if kept, ok, err := store.GetEventTLDR(ctx, db, id); err != nil {
		s.fail(w, err)
		return
	} else if ok {
		writeJSON(w, http.StatusOK, TLDRResponse{TLDR: kept.Text, Cached: true})
		return
	}
	if s.d.TLDR == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "AI;DR is not available in this build"})
		return
	}
	call := s.tldrSqueeze(id, text)
	select {
	case <-call.done:
	case <-ctx.Done():
		// The phone went away; the squeeze goes on and is kept for its
		// next tap.
		return
	}
	switch {
	case errors.Is(call.err, brain.ErrNoClaude):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Claude Code was not found on this computer: AI;DR asks your own claude"})
	case call.err != nil:
		s.d.Log.Warn("ai;dr: the squeeze failed", "component", "api", "event", id, "err", call.err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": call.err.Error()})
	default:
		writeJSON(w, http.StatusOK, TLDRResponse{TLDR: call.res.Text})
	}
}

// tldrSqueeze returns the squeeze of event id in flight, starting it when
// none is. The call runs under its own deadline, not the request's, so one
// tap that gives up does not fail the others waiting; its answer is kept
// before anyone waiting is released, so a tap after it reads the cache.
func (s *Server) tldrSqueeze(id int64, text string) *tldrCall {
	f := &s.tldr
	f.mu.Lock()
	defer f.mu.Unlock()
	if c, ok := f.calls[id]; ok {
		return c
	}
	if f.calls == nil {
		f.calls = map[int64]*tldrCall{}
	}
	c := &tldrCall{done: make(chan struct{})}
	f.calls[id] = c
	go func() {
		defer func() {
			f.mu.Lock()
			delete(f.calls, id)
			f.mu.Unlock()
			close(c.done)
		}()
		ctx, cancel := context.WithTimeout(context.Background(), tldrTimeout)
		defer cancel()
		c.res, c.err = brain.Squeeze(ctx, s.d.TLDR, text)
		if c.err != nil {
			if ctx.Err() != nil && !errors.Is(c.err, brain.ErrNoClaude) {
				c.err = errors.New("claude did not answer within a minute")
			}
			return
		}
		if err := store.PutEventTLDR(ctx, s.d.Store.DB(), store.EventTLDR{
			EventID: id, Text: c.res.Text, Model: c.res.Model, CostUSD: c.res.CostUSD, CreatedAt: s.d.Now().UnixMilli(),
		}); err != nil {
			s.d.Log.Warn("ai;dr: could not keep the squeeze", "component", "api", "event", id, "err", err)
		}
	}()
	return c
}
