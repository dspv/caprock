// A short-lived cache in front of the whole-history aggregates, with
// single-flight and stale-while-revalidate.
//
// /v1/history and the wide ranges of /v1/stats/summary (7d, 30d, all) answer
// from aggregates over the whole events table. On the owner's 1 GB database
// (333k events, 2026-10-04) /v1/history?range=all is ~1.5s and
// /v1/stats/summary?range=all ~1.0s through the Go driver, and the expensive
// half is per-row driver work over a covering scan — there is no index that
// fixes it. Measured under a live dashboard, where the same screen fires a
// dozen requests at once while ingest commits several times a second, those
// figures were 4.7s and 1.5s.
//
// What makes that hurt is how often it is asked. Five components on the main
// screen call `api.history('all')` on their own timers, the share dialog asks
// for today, 7d, 30d and all at once, and every one of them used to compute
// from scratch. Three things fix that, and none is a faster query:
//
//   - **Single-flight.** Requests for the same key that arrive while one is
//     already running wait for it and share its result, instead of starting
//     their own. This is what collapses a burst.
//   - **A short TTL.** Lifetime figures move by one turn at a time; an answer
//     younger than the TTL is handed back as it is.
//   - **Stale-while-revalidate.** An answer older than the TTL is still handed
//     back at once, and a single background refresh replaces it. Nobody waits
//     on a whole-table scan once the key has been computed — the cost moves
//     off the request and onto one goroutine. What the reader sees is at most
//     one refresh behind: the figure computed when the screen last asked.
//     Past maxStale an answer is too old to show, and the caller waits for a
//     fresh one as if there were none.
//
// The daemon also warms the common keys when it starts (Server.Warm), so the
// first screen after a restart does not pay for the scan either.
//
// Keys carry the range's resolved start, not just its label, so "today" and
// "7d" roll over at midnight: a new day is a new key, computed fresh, never
// yesterday's answer served under today's name.
//
// Writes do not invalidate. Wiring ingest into an HTTP cache would couple the
// recorder to the API, and with ingest committing several times a second while
// anyone works, an invalidated cache is an empty one exactly when the screen is
// busiest. The live figures — today's cost, the burn rate, the session cards —
// do not come through this cache at all.
package api

import (
	"context"
	"sync"
	"time"
)

const (
	// historyTTL is how long a computed history response is served without a
	// refresh. Short enough that no figure on screen is visibly behind, long
	// enough that a screen whose five components all ask at once computes the
	// answer once.
	historyTTL = 3 * time.Second
	// summaryTTL is the same for the 7d, 30d and all-time summaries. They are
	// asked for less often and move more slowly than the history strip.
	summaryTTL = 10 * time.Second
	// answerMaxStale bounds stale-while-revalidate. An answer older than this
	// — a dashboard reopened the next morning — is recomputed while the caller
	// waits rather than shown, because a figure from hours ago presented as
	// the current one is a wrong number, not a slow one.
	answerMaxStale = 30 * time.Minute
)

// answerEntry is one key's cached answer, or the in-flight computation of it.
// Waiters block on `done`; once it is closed `val`, `err` and `at` are settled
// and never change again (a refresh installs a new entry instead).
type answerEntry struct {
	done chan struct{}
	val  any
	err  error
	at   time.Time
	// refreshing is set while a background refresh of this entry runs, so a
	// burst of stale hits starts one refresh, not one each. Guarded by the
	// cache's mutex.
	refreshing bool
}

// answerCache memoises computed responses by key, makes concurrent callers for
// the same key share one computation, and serves a stale answer while it
// refreshes in the background.
type answerCache struct {
	mu       sync.Mutex
	m        map[string]*answerEntry
	ttl      time.Duration
	maxStale time.Duration
	now      func() time.Time
	// bg tracks background refreshes so tests can wait for them.
	bg sync.WaitGroup
}

// newAnswerCache returns a cache. maxStale <= ttl disables
// stale-while-revalidate: an expired answer is recomputed while the caller
// waits.
func newAnswerCache(ttl, maxStale time.Duration, now func() time.Time) *answerCache {
	if now == nil {
		now = time.Now
	}
	return &answerCache{m: map[string]*answerEntry{}, ttl: ttl, maxStale: maxStale, now: now}
}

// get returns the cached value for key, computing it with fn if there is no
// usable one. Concurrent callers for the same key wait on the first caller's
// computation rather than starting their own.
//
// The caller's context governs only its own wait: a caller that goes away does
// not cancel the computation others are waiting on. Browsers abandon requests
// routinely — a cancelled tab must not take the answer away from the tabs
// still waiting for it. fn is therefore expected to run on a context of its
// own.
func (c *answerCache) get(ctx context.Context, key string, fn func() (any, error)) (any, error) {
	c.mu.Lock()
	if e, ok := c.m[key]; ok {
		select {
		case <-e.done:
			age := c.now().Sub(e.at)
			if age < c.ttl {
				c.mu.Unlock()
				return e.val, e.err
			}
			if age < c.maxStale {
				// Stale but presentable: hand it back now and let one
				// background refresh replace it.
				if !e.refreshing {
					e.refreshing = true
					c.bg.Add(1)
					go c.refresh(key, e, fn)
				}
				c.mu.Unlock()
				return e.val, e.err
			}
			// Too old to show — recompute while the caller waits.
			delete(c.m, key)
		default:
			// In flight: wait for whoever started it.
			c.mu.Unlock()
			select {
			case <-e.done:
				return e.val, e.err
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
	}
	e := &answerEntry{done: make(chan struct{})}
	c.m[key] = e
	c.mu.Unlock()

	e.val, e.err = fn()
	e.at = c.now()
	close(e.done)

	// A failure is not cached: an error is usually transient (a busy database,
	// a cancelled read), and holding one for the TTL would turn one bad moment
	// into seconds of a broken screen.
	if e.err != nil {
		c.mu.Lock()
		if c.m[key] == e {
			delete(c.m, key)
		}
		c.mu.Unlock()
	}
	return e.val, e.err
}

// refresh recomputes a stale entry and installs the result. A failed refresh
// keeps the stale answer — it is still the best figure there is — and lets the
// next stale hit try again.
func (c *answerCache) refresh(key string, old *answerEntry, fn func() (any, error)) {
	defer c.bg.Done()
	val, err := fn()
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		old.refreshing = false
		return
	}
	if c.m[key] != old {
		// Replaced meanwhile (expired past maxStale and recomputed); the newer
		// entry wins.
		return
	}
	fresh := &answerEntry{done: make(chan struct{}), val: val, at: c.now()}
	close(fresh.done)
	c.m[key] = fresh
}

// wait blocks until every background refresh started so far has finished.
func (c *answerCache) wait() { c.bg.Wait() }

// forget drops every answer, so the next read of each key computes it afresh.
// For the rare write that changes history rather than adds to it — removing a
// session — not for ingest (see the package comment).
func (c *answerCache) forget() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m = map[string]*answerEntry{}
}
