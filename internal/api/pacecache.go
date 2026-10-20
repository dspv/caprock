package api

import (
	"context"
	"strconv"
	"sync"

	"github.com/dspv/caprock/internal/store"
)

// paceCache keeps store.RateLimitPace's answer per plan window and reset,
// keyed by the newest history sample (store.RateLimitHistoryMark).
//
// Every /v1/stats/summary asks for both windows' slope, and the Now screen
// asks for the summary up to once a second while agents work. Each slope
// walked every sample of the window's reset and fetched each row: 298 such
// reads in 180 s were 117 MB of page reads on a preview stand with the
// owner's 1.85 GB database, from a table of 0.8 MB (F17,
// docs/resource-usage-audit-2026-10-18.md). A sample is appended at most
// every 30 s and only later than the newest, so while the newest has not
// moved the slope is the same; it is counted again when it has.
type paceCache struct {
	mu sync.Mutex
	m  map[string]paceEntry
}

type paceEntry struct {
	mark       int64
	pctPerHour float64
	ok         bool
}

func (c *paceCache) get(ctx context.Context, q store.Querier, window string, resetsAt int64) (float64, bool, error) {
	mark, err := store.RateLimitHistoryMark(ctx, q, window)
	if err != nil {
		return 0, false, err
	}
	key := window + "|" + strconv.FormatInt(resetsAt, 10)
	c.mu.Lock()
	if e, ok := c.m[key]; ok && e.mark == mark {
		c.mu.Unlock()
		return e.pctPerHour, e.ok, nil
	}
	c.mu.Unlock()
	pct, ok, err := store.RateLimitPace(ctx, q, window, resetsAt)
	if err != nil {
		return 0, false, err
	}
	c.mu.Lock()
	if c.m == nil || len(c.m) >= 16 {
		c.m = map[string]paceEntry{} // two windows, a new key per reset
	}
	c.m[key] = paceEntry{mark: mark, pctPerHour: pct, ok: ok}
	c.mu.Unlock()
	return pct, ok, nil
}
