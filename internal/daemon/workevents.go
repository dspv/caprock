package daemon

import (
	"context"
	"sync"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// workEvents keeps the Work board's reads of each live session's newest
// events, keyed by the session's store.EventsGen, as the sessions list keeps
// its own (internal/api/recentcache.go, F14).
//
// GET /v1/work is read on live frames, up to once a second with agents at
// work, and each read took every live session's newest 30 main-thread events
// and its newest 40 turn events, payloads included: on a preview stand with
// the owner's 1.85 GB database and 13 live sessions, 2,554 such reads in
// 180 s fetched 365 MB of pages, the largest share of the Now screen's
// database reads (F17, docs/resource-usage-audit-2026-10-18.md). A session
// whose events have not changed since the last read gets the same events
// and the same task list (SessionTodos, which parses every TodoWrite call's
// payload, was the next largest read); only the derived state, which also
// depends on the clock, is worked out again.
//
// The generation is read before the events, so a kept read is never older
// than its key: at worst it includes a write that landed in between, and the
// next request, seeing the newer generation, reads again.
type workEvents struct {
	mu sync.Mutex
	m  map[string]*workEventsEntry
}

// workEventsMax bounds the sessions kept; the board lists at most
// workSessionMax live sessions, and an entry for a session no longer listed
// is dropped once the map is full.
const workEventsMax = 256

type workEventsEntry struct {
	gen store.EventsGen
	// live marks an entry the current Work read used.
	live bool

	mu    sync.Mutex
	turns *[]event.Event // queueTurnScan turn events
	state *[]event.Event // workStateScan main-thread events
	// todo is the agent's task list (todoOf), which only its own events
	// move; todoRead says it has been read, todo being nil for a session
	// that never kept one.
	todo     *api.BoardTodo
	todoRead bool
}

// readTodo returns the entry's task list, reading it the first time.
func (e *workEventsEntry) readTodo(load func() (*api.BoardTodo, error)) (*api.BoardTodo, error) {
	e.mu.Lock()
	if e.todoRead {
		t := e.todo
		e.mu.Unlock()
		return t, nil
	}
	e.mu.Unlock()
	t, err := load()
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.todoRead {
		e.todo, e.todoRead = t, true
	}
	return e.todo, nil
}

// entry is the session's entry at gen. An older gen than the kept one (a
// request that read it before a write the cache has already seen) gets an
// entry of its own that is not kept.
func (c *workEvents) entry(id string, gen store.EventsGen) *workEventsEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string]*workEventsEntry{}
	}
	e, ok := c.m[id]
	switch {
	case ok && e.gen == gen:
		e.live = true
		return e
	case ok && gen.Older(e.gen):
		return &workEventsEntry{gen: gen}
	}
	if !ok && len(c.m) >= workEventsMax {
		for k, old := range c.m {
			if !old.live {
				delete(c.m, k)
			}
		}
		if len(c.m) >= workEventsMax {
			c.m = map[string]*workEventsEntry{}
		}
	}
	e = &workEventsEntry{gen: gen, live: true}
	c.m[id] = e
	return e
}

// sweep forgets which entries the last read used, so the next full map drops
// those of sessions that have since ended.
func (c *workEvents) sweep() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, e := range c.m {
		e.live = false
	}
}

// read returns *slot, loading it the first time. The load runs outside the
// lock: two requests may both read, and the first to finish is kept. The
// slice is shared and must not be written to.
func (e *workEventsEntry) read(slot **[]event.Event, load func() ([]event.Event, error)) ([]event.Event, error) {
	e.mu.Lock()
	if p := *slot; p != nil {
		e.mu.Unlock()
		return *p, nil
	}
	e.mu.Unlock()
	v, err := load()
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if *slot == nil {
		*slot = &v
	}
	return **slot, nil
}

// sessionEvents is the entry for one session at its current generation.
func (w *workBoard) sessionEvents(ctx context.Context, id string) (*workEventsEntry, error) {
	gen, err := store.ReadEventsGen(ctx, w.d.store.DB(), id)
	if err != nil {
		return nil, err
	}
	return w.events.entry(id, gen), nil
}
