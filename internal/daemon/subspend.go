package daemon

import (
	"context"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// subSpendTTL is how long the Subscriptions answer reuses its week of spend.
//
// GET /v1/subscriptions sums a week of assistant turns joined to their
// sessions (store.SpendBySubscription) on every request, and every picker
// that offers a subscription asks for it when it opens, the Settings page
// every 10 s. On the owner's machine, swapping, the statement took about
// 500 ms each time and recurred every two or three seconds while the window
// was reloaded (2026-10-21). A week's spend per subscription moves by one
// turn at a time, the same reasoning that keeps a wide history for a minute
// (historyWideTTL in internal/api/answercache.go).
const subSpendTTL = time.Minute

// subSpendCache is the last week of spend by subscription, with
// single-flight: callers that arrive while one sum runs wait for it.
type subSpendCache struct {
	mu   sync.Mutex
	at   time.Time
	rows []store.SubscriptionSpend
	// busy is closed when the running sum ends; nil when none runs.
	busy chan struct{}
}

// get returns the week of spend before now, summing it again once the last
// sum is subSpendTTL old. An error is returned and not kept, so the next call
// tries again.
func (c *subSpendCache) get(ctx context.Context, st *store.Store, now time.Time) ([]store.SubscriptionSpend, error) {
	for {
		c.mu.Lock()
		if !c.at.IsZero() && now.Sub(c.at) < subSpendTTL {
			rows := c.rows
			c.mu.Unlock()
			return rows, nil
		}
		if c.busy == nil {
			break
		}
		wait := c.busy
		c.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	done := make(chan struct{})
	c.busy = done
	c.mu.Unlock()

	rows, err := store.SpendBySubscription(context.WithoutCancel(ctx), st.DB(), now.Add(-7*24*time.Hour).UnixMilli())

	c.mu.Lock()
	if err == nil {
		c.rows, c.at = rows, now
	}
	c.busy = nil
	c.mu.Unlock()
	close(done)
	return rows, err
}
