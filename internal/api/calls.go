package api

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// SessionCall is one entry of GET /v1/sessions/{id}/calls: a priced model
// call of the main thread, as the cockpit's spend scrubber reads it.
type SessionCall struct {
	ID           int64             `json:"id"`
	Ts           int64             `json:"ts"`
	Model        string            `json:"model,omitempty"`
	ModelDisplay string            `json:"model_display,omitempty"`
	CostUSD      float64           `json:"cost_usd"`
	Tokens       *event.TokenDelta `json:"tokens,omitempty"`
	Tools        []CallTool        `json:"tools,omitempty"`
	ToolCount    int               `json:"tool_count,omitempty"`
}

// CallTool is a tool call a model call asked for, with the short line the
// cockpit's tool list gives it.
type CallTool struct {
	Tool   string `json:"tool"`
	Detail string `json:"detail,omitempty"`
}

// handleSessionCalls returns a session's priced main-thread model calls,
// oldest first: the whole series the spark at the top of the cockpit only
// shows the end of. Lean on purpose — no prose, no tool results — so a
// session of thousands of calls is one small response.
//
// A session's calls are kept by its events generation (store.EventsGen, read
// before the calls): asked again while its events are as they were — a
// cockpit tab opened again, the several parts of one tab that ask at once —
// it reads nothing, and identical requests in flight share one read. A whole
// read walks every priced turn and every tool call of the session, the tool
// calls' payloads included: 1.4 s and 5,172 calls for one of the owner's
// sessions (2026-11-20), and the cockpit asks each time it opens. So while
// the session's calls generation stands (new rows, links, text merges and
// compression do not move it), the series kept from the last read is
// extended by what changed instead (store.ReadSessionCalls).
func (s *Server) handleSessionCalls(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	id := r.PathValue("id")
	db := s.d.Store.DB()
	gen, err := store.ReadEventsGen(r.Context(), db, id)
	if err != nil {
		s.fail(w, err)
		return
	}
	key := fmt.Sprintf("%s|%d|%d|%d", id, limit, gen.Gen, gen.MaxID)
	v, err := s.callsCache().get(r.Context(), key, func() (any, error) {
		base := fmt.Sprintf("%s|%d", id, limit)
		ser, err := store.ReadSessionCalls(context.WithoutCancel(r.Context()), db, id, limit, s.calls.last(base))
		if err != nil {
			return nil, err
		}
		s.calls.keep(base, ser)
		return ser.Calls, nil
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	calls, _ := v.([]store.SessionCall)
	out := make([]SessionCall, 0, len(calls))
	display := map[string]string{}
	for _, c := range calls {
		d, ok := display[c.Model]
		if !ok {
			d = s.modelDisplay(c.Model)
			display[c.Model] = d
		}
		sc := SessionCall{ID: c.ID, Ts: c.Ts, Model: c.Model, ModelDisplay: d, CostUSD: c.CostUSD, Tokens: c.Tokens, ToolCount: c.ToolCount}
		for _, t := range c.Tools {
			sc.Tools = append(sc.Tools, CallTool{Tool: t.Tool, Detail: callDetail(t.Tool, t.Input)})
		}
		out = append(out, sc)
	}
	writeJSON(w, http.StatusOK, out)
}

// sessionCallsKeep is how long a session's calls are kept unasked and
// sessionCallsKeys how many answers at most: an answer is keyed by its
// session's generation, so it is never stale, and these bound only memory.
const (
	sessionCallsKeep = 10 * time.Minute
	sessionCallsKeys = 32
)

// sessionCalls holds GET /v1/sessions/{id}/calls answers (handleSessionCalls),
// and the series each session was last read as, which the next read extends
// by the rows added since (store.ReadSessionCalls).
type sessionCalls struct {
	once sync.Once
	c    *answerCache

	mu     sync.Mutex
	series map[string]keptSeries
}

type keptSeries struct {
	s  *store.CallsSeries
	at time.Time
}

// last is the series key was last read as, nil when none is kept.
func (c *sessionCalls) last(key string) *store.CallsSeries {
	c.mu.Lock()
	defer c.mu.Unlock()
	k, ok := c.series[key]
	if !ok || time.Since(k.at) > sessionCallsKeep {
		return nil
	}
	return k.s
}

// keep records s as key's newest series, keeping sessionCallsKeys at most:
// past it the one read longest ago goes.
func (c *sessionCalls) keep(key string, s *store.CallsSeries) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.series == nil {
		c.series = map[string]keptSeries{}
	}
	if k, ok := c.series[key]; ok && s.Mark.Older(k.s.Mark) {
		return // a slower read of an older state: the newer one stays
	}
	c.series[key] = keptSeries{s: s, at: time.Now()}
	for len(c.series) > sessionCallsKeys {
		oldest := ""
		for k, v := range c.series {
			if oldest == "" || v.at.Before(c.series[oldest].at) {
				oldest = k
			}
		}
		delete(c.series, oldest)
	}
}

func (s *Server) callsCache() *answerCache {
	s.calls.once.Do(func() {
		s.calls.c = newAnswerCache(sessionCallsKeep, sessionCallsKeep, time.Now)
		s.calls.c.maxKeys = sessionCallsKeys
	})
	return s.calls.c
}
