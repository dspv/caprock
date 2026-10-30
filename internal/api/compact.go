package api

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"
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
	// Estimate is what the newest compaction cost and has saved since,
	// from the pricing table: absent until the minute's pass has made its
	// row (rollup.RefreshCompactionStats).
	Estimate *CompactionEstimate `json:"estimate,omitempty"`
}

// CompactionEstimate is the cost and saving of one compaction, estimated
// (rule 6; 03-contracts.md § Compaction stats DDL).
type CompactionEstimate struct {
	At    int64  `json:"at"`
	Model string `json:"model,omitempty"`
	// Warm is whether the context was taken as read from the cache.
	Warm bool `json:"warm"`
	// SummaryTokensEst is the summary's length / 4; absent when it was not
	// read, and then the cost leaves the output out.
	SummaryTokensEst *int64 `json:"summary_tokens_est,omitempty"`
	// EstCostUSD is absent when the model is not in the pricing table, or
	// none is known yet.
	EstCostUSD  *float64 `json:"est_cost_usd,omitempty"`
	EstSavedUSD float64  `json:"est_saved_usd"`
	TurnsAfter  int64    `json:"turns_after"`
	// Series is the saving accumulated since the boundary, at most
	// CompactSeriesMax points, oldest first; the first is the boundary at 0,
	// the last the newest call.
	Series         []SavingPoint `json:"series"`
	PricingVersion string        `json:"pricing_version"`
}

// SavingPoint is the cumulative estimated saving at a moment, unix ms.
type SavingPoint struct {
	At       int64   `json:"at"`
	SavedUSD float64 `json:"saved_usd"`
}

// CompactSeriesMax is the most points a savings series has.
const CompactSeriesMax = 24

// compactSeriesCalls bounds the calls one series reads.
const compactSeriesCalls = 50_000

// compactionEstimate is the newest compaction's estimate for a session: the
// stored row's cost, and the saving counted again from the calls since, so
// the series and its end are as fresh as the events.
func (s *Server) compactionEstimate(ctx context.Context, q store.Querier, id string, last store.Compaction) (*CompactionEstimate, error) {
	row, ok, err := store.LatestCompactionStat(ctx, q, id)
	if err != nil || !ok || row.At != last.At {
		return nil, err
	}
	e := &CompactionEstimate{At: row.At, Model: row.Model, Warm: row.Warm, TurnsAfter: row.TurnsAfter,
		EstSavedUSD: row.EstSavedUSD, PricingVersion: row.PricingVersion, Series: []SavingPoint{{At: row.At}}}
	if row.SummaryTokensEst.Valid {
		v := row.SummaryTokensEst.Int64
		e.SummaryTokensEst = &v
	}
	if row.EstCostUSD.Valid && !row.CostStale {
		v := row.EstCostUSD.Float64
		e.EstCostUSD = &v
	}
	if s.d.Table == nil {
		return e, nil
	}
	before := int64(math.MaxInt64)
	if row.NextAt.Valid {
		before = row.NextAt.Int64
	}
	calls, err := store.MainCallsAfter(ctx, q, row.Sid, row.At, 0, before, compactSeriesCalls)
	if err != nil {
		return nil, err
	}
	post := row.PostTokens
	cum := make([]SavingPoint, 0, len(calls))
	var saved float64
	for _, c := range calls {
		if post == 0 {
			post = c.Prompt()
		}
		if v, ok := s.d.Table.CompactionSaving(c.Model, time.UnixMilli(c.Ts), row.PreTokens-post); ok {
			saved += v
		}
		cum = append(cum, SavingPoint{At: c.Ts, SavedUSD: saved})
	}
	if len(calls) > 0 {
		e.EstSavedUSD, e.TurnsAfter = saved, int64(len(calls))
	}
	e.Series = append(e.Series, thinSeries(cum, CompactSeriesMax-1)...)
	return e, nil
}

// thinSeries keeps at most n points of a cumulative series, evenly spaced
// by position, the last always among them.
func thinSeries(pts []SavingPoint, n int) []SavingPoint {
	if len(pts) <= n {
		return pts
	}
	out := make([]SavingPoint, 0, n)
	for i := 1; i <= n; i++ {
		out = append(out, pts[i*len(pts)/n-1])
	}
	return out
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
		if v.Estimate, err = s.compactionEstimate(ctx, db, id, last); err != nil {
			s.fail(w, err)
			return
		}
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

// CompactionPeriod is GET /v1/stats/compactions: the compactions of a
// window, by the boundary's time, with what each cost and has saved to date,
// all estimates (03-contracts.md § Compaction stats DDL).
type CompactionPeriod struct {
	// Range is the range asked for ("today", "7d", "30d", "all"), empty
	// for an explicit from/to.
	Range string `json:"range,omitempty"`
	store.CompactionTotals
	PricingVersion string `json:"pricing_version,omitempty"`
}

// handleCompactionPeriod is GET /v1/stats/compactions?range= (as
// /v1/stats/summary reads it) or ?from=&to= (unix ms, to exclusive, as a
// Week's window is).
func (s *Server) handleCompactionPeriod(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var (
		from, to int64
		label    string
	)
	if q.Get("from") != "" || q.Get("to") != "" {
		var err1, err2 error
		from, err1 = strconv.ParseInt(q.Get("from"), 10, 64)
		to, err2 = strconv.ParseInt(q.Get("to"), 10, 64)
		if err1 != nil || err2 != nil || to <= from {
			s.failCode(w, http.StatusBadRequest, errors.New("from and to are unix ms, from before to"))
			return
		}
	} else {
		from, label = s.rangeFrom(q.Get("range"))
		to = math.MaxInt64
	}
	t, err := store.CompactionTotalsBetween(r.Context(), s.d.Store.DB(), from, to)
	if err != nil {
		s.fail(w, err)
		return
	}
	v := CompactionPeriod{Range: label, CompactionTotals: t}
	if s.d.Table != nil {
		v.PricingVersion = s.d.Table.Version
	}
	writeJSON(w, http.StatusOK, v)
}
