package api

import (
	"sync"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// recentCache keeps what a session summary reads from its session's events
// (summarize): the newest events, the main thread's newest event and turn, and
// the first prompts. The sessions list summarises every session it lists on
// every request, and the dashboard asks for it several times a second, so
// these reads were the largest cost in the daemon after the all-time history
// (F14, docs/resource-usage-audit-2026-10-18.md).
//
// An entry is keyed by the session's store.EventsGen, its newest event id and
// a rewrite generation that triggers move with every update or delete of its
// events, so an entry is used only while the session's events are what they
// were when it was read. Everything else in a
// summary (the clock, the session row, live subagents, loops, nudges, stats)
// is read fresh on every request; only the reads of the events are kept.
//
// The key is read before the events, so a value is never older than
// its key: at worst it holds a write that landed in between, and the next
// request, seeing the newer generation, reads again.
type recentCache struct {
	mu   sync.Mutex
	m    map[string]*recentEntry
	tick uint64
}

// recentCacheMax bounds the sessions kept: the least recently used is dropped
// first. Lists ask for 50 or 200 sessions at most, and the live ones, which
// change, are a few of those.
const recentCacheMax = 256

// recentEntry is one session's reads at one generation. Each value is read
// the first time a summary needs it and shared, read-only, after that.
type recentEntry struct {
	gen  store.EventsGen
	used uint64

	mu       sync.Mutex
	last     lazy[[]event.Event]
	mainLast lazy[[]event.Event]
	mainTurn lazy[foundEvent]
	prompts  lazy[[]string]
}

// lazy is one value of an entry, and whether it has been read.
type lazy[T any] struct {
	v    T
	have bool
}

// foundEvent is store.LastMainTurn's answer.
type foundEvent struct {
	ev    event.Event
	found bool
}

// readOnce returns l's value, reading it with load the first time. load runs
// outside the lock: two requests may both read, and the first to finish is
// kept.
func readOnce[T any](mu *sync.Mutex, l *lazy[T], load func() (T, error)) (T, error) {
	mu.Lock()
	if l.have {
		v := l.v
		mu.Unlock()
		return v, nil
	}
	mu.Unlock()
	v, err := load()
	if err != nil {
		return v, err
	}
	mu.Lock()
	defer mu.Unlock()
	if !l.have {
		l.v, l.have = v, true
	}
	return l.v, nil
}

// entry is the session's entry at gen. A newer generation replaces the entry;
// an older one, from a request that read the generation before a write the
// cache has already seen, gets an entry of its own that is not kept.
func (c *recentCache) entry(sessionID string, gen store.EventsGen) *recentEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.tick++
	if c.m == nil {
		c.m = map[string]*recentEntry{}
	}
	e, ok := c.m[sessionID]
	switch {
	case ok && e.gen == gen:
		e.used = c.tick
		return e
	case ok && gen.Older(e.gen):
		return &recentEntry{gen: gen}
	}
	if !ok && len(c.m) >= recentCacheMax {
		c.evictLocked()
	}
	e = &recentEntry{gen: gen, used: c.tick}
	c.m[sessionID] = e
	return e
}

// evictLocked drops the least recently used entry.
func (c *recentCache) evictLocked() {
	var oldest string
	var at uint64
	first := true
	for id, e := range c.m {
		if first || e.used < at {
			oldest, at, first = id, e.used, false
		}
	}
	if !first {
		delete(c.m, oldest)
	}
}

// size is how many sessions are kept (tests).
func (c *recentCache) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.m)
}
