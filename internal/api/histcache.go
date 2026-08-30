// A short-lived cache in front of /v1/history, and single-flight around it.
//
// The endpoint answers "everything, ever": four aggregates over the whole
// events table. On the owner's 600 MB database that is ~540ms warm, and the
// expensive half is a 160,000-row scan whose cost is per-row driver work
// rather than SQL — `sqlite3` runs the same scan in 160ms, so there is no
// index that fixes it.
//
// What makes that hurt is how it is asked for. Five components on the main
// screen call `api.history('all')` on their own timers — the lifetime strip,
// the breakdown panel, the share card, the share nudge, and the screen itself
// — so a single open tab produces bursts of identical requests, and each one
// was computed from scratch. Three arriving together took three connections
// and roughly three times the work to produce three identical answers.
//
// Two things fix that, and neither is a faster query:
//
//   - **Single-flight.** Requests for the same range that arrive while one is
//     already running wait for it and share its result, instead of starting
//     their own. This is what collapses the burst.
//   - **A short TTL.** Lifetime figures move by one turn at a time; serving a
//     few-second-old copy is invisible on a screen that polls every 60s.
//
// The TTL is deliberately shorter than the fastest poller. It exists to
// collapse a burst, not to serve stale numbers: anyone who reloads the page
// gets figures no older than `historyTTL`, and the live pulse — which is what
// people actually watch move — does not come through this endpoint at all.
//
// Writes do not invalidate it. An entry expires on its own within seconds, and
// wiring ingest into an HTTP cache would couple the recorder to the API for a
// few seconds of freshness nobody can perceive.
package api

import (
	"context"
	"sync"
	"time"
)

// historyTTL is how long a computed history response may be reused.
//
// Short enough that no figure on screen is visibly behind, long enough that a
// screen whose five components all ask at once computes the answer once.
const historyTTL = 3 * time.Second

// historyEntry is one range's cached answer, or the in-flight computation of
// it. Exactly one of `done`/`val` is meaningful at a time: waiters block on
// `done`, and readers of a settled entry take `val` and `err`.
type historyEntry struct {
	done chan struct{}
	val  any
	err  error
	at   time.Time
}

// historyCache memoises history responses by range key, and makes concurrent
// callers for the same key share one computation.
type historyCache struct {
	mu  sync.Mutex
	m   map[string]*historyEntry
	ttl time.Duration
	now func() time.Time
}

func newHistoryCache(ttl time.Duration, now func() time.Time) *historyCache {
	if now == nil {
		now = time.Now
	}
	return &historyCache{m: map[string]*historyEntry{}, ttl: ttl, now: now}
}

// get returns the cached value for key, computing it with fn if there is no
// fresh one. Concurrent callers for the same key wait on the first caller's
// computation rather than starting their own.
//
// The caller's context governs only its own wait: a caller that goes away does
// not cancel the computation others are waiting on. That matters here because
// browsers abandon requests routinely — a cancelled tab must not take the
// answer away from the two tabs still waiting for it.
func (c *historyCache) get(ctx context.Context, key string, fn func() (any, error)) (any, error) {
	c.mu.Lock()
	if e, ok := c.m[key]; ok {
		// Settled and fresh: hand it straight back.
		select {
		case <-e.done:
			if c.now().Sub(e.at) < c.ttl {
				c.mu.Unlock()
				return e.val, e.err
			}
			// Stale — fall through and recompute.
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
	e := &historyEntry{done: make(chan struct{})}
	c.m[key] = e
	c.mu.Unlock()

	// Computed on a background context on purpose. See the note above: the
	// first caller's disconnect must not fail the callers waiting behind it.
	e.val, e.err = fn()
	e.at = c.now()
	close(e.done)

	// A failure is not cached: an error is usually transient (a busy database,
	// a cancelled read), and holding one for the TTL would turn one bad moment
	// into three seconds of a broken screen.
	if e.err != nil {
		c.mu.Lock()
		if c.m[key] == e {
			delete(c.m, key)
		}
		c.mu.Unlock()
	}
	return e.val, e.err
}
