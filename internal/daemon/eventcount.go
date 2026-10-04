package daemon

import (
	"context"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// eventCountTTL is how long /v1/status reuses the stored-event count before a
// background recount.
const eventCountTTL = 30 * time.Second

// eventCounter caches the number of stored events for /v1/status.
//
// COUNT(*) over events walks an index of every row: 333k on the owner's 1 GB
// database, measured at 600ms on a cold connection (2026-10-04) — and every
// connection is cold again after each ingest commit. /v1/status is polled and
// shows the figure as a size, where a count half a minute old is
// indistinguishable from a fresh one. So the count is taken in the background
// and the endpoint reads the last one; only the very first read waits.
type eventCounter struct {
	mu      sync.Mutex
	n       int64
	at      time.Time
	ok      bool
	running bool
}

// get returns the last count, starting a background recount when it is older
// than eventCountTTL. The first call, with nothing counted yet, counts in place
// so the figure is never an invented zero.
func (c *eventCounter) get(ctx context.Context, st *store.Store) (int64, bool) {
	c.mu.Lock()
	if !c.ok {
		c.mu.Unlock()
		c.refresh(ctx, st)
		c.mu.Lock()
		n, ok := c.n, c.ok
		c.mu.Unlock()
		return n, ok
	}
	if time.Since(c.at) >= eventCountTTL && !c.running {
		c.running = true
		go c.refresh(context.WithoutCancel(ctx), st)
	}
	n := c.n
	c.mu.Unlock()
	return n, true
}

func (c *eventCounter) refresh(ctx context.Context, st *store.Store) {
	n, err := store.CountEvents(ctx, st.DB())
	c.mu.Lock()
	defer c.mu.Unlock()
	c.running = false
	if err != nil {
		return // keep the last count; the next read tries again
	}
	c.n, c.at, c.ok = n, time.Now(), true
}
