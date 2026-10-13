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
	// todayTTL is how long today's summary is served as it is. It is the
	// figure people watch move, so it is never served stale: past this it is
	// renewed if nothing was written, and otherwise counted while the caller
	// waits. Several components ask for it every few seconds.
	todayTTL = 2 * time.Second
	// answerMaxStale bounds stale-while-revalidate. An answer older than this
	// — a dashboard reopened the next morning — is recomputed while the caller
	// waits rather than shown, because a figure from hours ago presented as
	// the current one is a wrong number, not a slow one.
	answerMaxStale = 30 * time.Minute
	// answerRecheck bounds how long an answer is renewed on an unchanged
	// version alone. A write that removes rows (retention, removing a
	// session) adds no event, so past this an answer is recomputed anyway.
	answerRecheck = 10 * time.Minute
	// usualTTL is how long the cockpit's 30-day baseline is served as it is,
	// and usualMaxStale how long past that it is still handed back while one
	// refresh runs: thirty days of history do not move in an afternoon.
	usualTTL      = 10 * time.Minute
	usualMaxStale = 24 * time.Hour
)

// answerEntry is one key's cached answer, or the in-flight computation of it.
// Waiters block on `done`; once it is closed `val`, `err` and `at` are settled
// and never change again (a refresh installs a new entry instead).
type answerEntry struct {
	done chan struct{}
	val  any
	err  error
	at   time.Time
	// ver is the data version read just before the answer was computed, or
	// -1 when there was no version to read.
	ver int64
	// refreshing is set while a background refresh of this entry runs, so a
	// burst of stale hits starts one refresh, not one each. Guarded by the
	// cache's mutex.
	refreshing bool
	// next is closed when that background refresh ends, installed or not, so
	// a caller with a budget (answerCache.budget) can wait on it briefly.
	// Guarded by the cache's mutex.
	next chan struct{}
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
	// version, when set, reads the data's version: an expired answer whose
	// version has not moved is still right, and is renewed instead of being
	// computed again. Nil means every expired answer is recomputed.
	version func(context.Context) (int64, error)
	// recheck bounds how long an answer is renewed on an unchanged version
	// alone (answerRecheck unless set).
	recheck time.Duration
	// budget, when set, is how long a caller holding a stale answer waits for
	// the refresh it started before taking the stale one: a refresh the
	// sources answer from what they hold lands inside it, so the reader is
	// not one poll behind, and a slow one (a read from GitHub) does not hold
	// the reader up. Zero hands the stale answer back at once.
	budget time.Duration
	// maxKeys, when set, bounds how many keys are kept: past it, answers
	// older than maxStale go first, then the oldest settled ones.
	maxKeys int
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
	v, _, _, err := c.getAt(ctx, key, fn)
	return v, err
}

// getAt is get, also saying when the answer handed back was computed and
// whether it is a stale one whose refresh is still running.
func (c *answerCache) getAt(ctx context.Context, key string, fn func() (any, error)) (any, time.Time, bool, error) {
	c.mu.Lock()
	if e, ok := c.m[key]; ok {
		select {
		case <-e.done:
			age := c.now().Sub(e.at)
			if age < c.ttl {
				c.mu.Unlock()
				return e.val, e.at, false, e.err
			}
			if c.version != nil && e.ver >= 0 && age < c.recheckAfter() {
				if c.unchanged(ctx, key, e) {
					return c.settled(key, e)
				}
				c.mu.Lock()
				if c.m[key] != e {
					// Replaced while the version was read; start over.
					c.mu.Unlock()
					return c.getAt(ctx, key, fn)
				}
				age = c.now().Sub(e.at)
			}
			if age < c.maxStale {
				// Stale but presentable: hand it back now and let one
				// background refresh replace it.
				if !e.refreshing {
					e.refreshing = true
					e.next = make(chan struct{})
					c.bg.Add(1)
					go c.refresh(key, e, fn, e.next)
				}
				next := e.next
				c.mu.Unlock()
				return c.waitBudget(ctx, key, e, next)
			}
			// Too old to show — recompute while the caller waits.
			delete(c.m, key)
		default:
			// In flight: wait for whoever started it.
			c.mu.Unlock()
			select {
			case <-e.done:
				return e.val, e.at, false, e.err
			case <-ctx.Done():
				return nil, time.Time{}, false, ctx.Err()
			}
		}
	}
	c.prune()
	e := &answerEntry{done: make(chan struct{})}
	c.m[key] = e
	c.mu.Unlock()

	e.ver = c.readVersion(ctx)
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
	return e.val, e.at, false, e.err
}

// settled is the answer installed for key once it is settled, else e's: what
// a renewed answer hands back.
func (c *answerCache) settled(key string, e *answerEntry) (any, time.Time, bool, error) {
	c.mu.Lock()
	if f := c.m[key]; f != nil {
		select {
		case <-f.done:
			e = f
		default:
		}
	}
	c.mu.Unlock()
	return e.val, e.at, false, e.err
}

// waitBudget hands back the stale entry e, or what replaced it when the
// refresh (next) ends inside the cache's budget. The bool is true while the
// answer handed back is stale and its refresh still runs.
func (c *answerCache) waitBudget(ctx context.Context, key string, e *answerEntry, next chan struct{}) (any, time.Time, bool, error) {
	if c.budget <= 0 {
		return e.val, e.at, true, e.err
	}
	t := time.NewTimer(c.budget)
	defer t.Stop()
	select {
	case <-next:
		c.mu.Lock()
		f := c.m[key]
		c.mu.Unlock()
		if f != nil && f != e {
			select {
			case <-f.done:
				return f.val, f.at, false, f.err
			default:
			}
		}
		// The refresh failed: the stale answer is still the best there is.
		return e.val, e.at, false, e.err
	case <-t.C:
	case <-ctx.Done():
	}
	return e.val, e.at, true, e.err
}

// prune is called with c.mu held before a key is added. Past maxKeys it drops
// the answers too old to show, then the oldest settled ones.
func (c *answerCache) prune() {
	if c.maxKeys <= 0 || len(c.m) < c.maxKeys {
		return
	}
	now := c.now()
	settled := func(e *answerEntry) bool {
		select {
		case <-e.done:
			return !e.refreshing
		default:
			return false
		}
	}
	for k, e := range c.m {
		if settled(e) && now.Sub(e.at) >= c.maxStale {
			delete(c.m, k)
		}
	}
	for len(c.m) >= c.maxKeys {
		oldest := ""
		var at time.Time
		for k, e := range c.m {
			if settled(e) && (oldest == "" || e.at.Before(at)) {
				oldest, at = k, e.at
			}
		}
		if oldest == "" {
			return
		}
		delete(c.m, oldest)
	}
}

// refresh recomputes a stale entry and installs the result. A failed refresh
// keeps the stale answer — it is still the best figure there is — and lets the
// next stale hit try again. next is closed once it is done either way.
func (c *answerCache) refresh(key string, old *answerEntry, fn func() (any, error), next chan struct{}) {
	defer c.bg.Done()
	ver := c.readVersion(context.Background())
	val, err := fn()
	c.mu.Lock()
	defer c.mu.Unlock()
	defer close(next)
	if err != nil {
		old.refreshing = false
		return
	}
	if c.m[key] != old {
		// Replaced meanwhile (expired past maxStale and recomputed); the newer
		// entry wins.
		return
	}
	fresh := &answerEntry{done: make(chan struct{}), val: val, at: c.now(), ver: ver}
	close(fresh.done)
	c.m[key] = fresh
}

// unchanged is called with c.mu held and an expired, settled entry. It reads
// the data's version without the lock and, when the version is the one the
// answer was computed at, renews the entry and returns true with c.mu
// released. Otherwise it returns false with c.mu released, and the caller
// takes the lock again.
func (c *answerCache) unchanged(ctx context.Context, key string, e *answerEntry) bool {
	c.mu.Unlock()
	v := c.readVersion(ctx)
	if v < 0 || v != e.ver {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m[key] != e {
		return true // a newer answer is installed; this one was still right
	}
	renewed := &answerEntry{done: make(chan struct{}), val: e.val, err: e.err, at: c.now(), ver: e.ver}
	close(renewed.done)
	c.m[key] = renewed
	return true
}

// versioned makes c renew expired answers whose data version has not moved,
// for at most recheck after each was computed. It returns c.
func (c *answerCache) versioned(version func(context.Context) (int64, error), recheck time.Duration) *answerCache {
	c.version, c.recheck = version, recheck
	return c
}

func (c *answerCache) recheckAfter() time.Duration {
	if c.recheck > 0 {
		return c.recheck
	}
	return answerRecheck
}

// readVersion is the data version, or -1 when there is none to read.
func (c *answerCache) readVersion(ctx context.Context) int64 {
	if c.version == nil {
		return -1
	}
	v, err := c.version(context.WithoutCancel(ctx))
	if err != nil {
		return -1
	}
	return v
}

// kept reports whether key has a finished answer young enough to be shown:
// a request for it gets that answer (stale, refreshing) within the budget,
// so it needs no quick answer of its own (serveDeckOrQuick).
func (c *answerCache) kept(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[key]
	if !ok {
		return false
	}
	select {
	case <-e.done:
		return e.err == nil && c.now().Sub(e.at) < c.maxStale
	default:
		return false
	}
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
