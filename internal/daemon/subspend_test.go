package daemon

import (
	"context"
	"testing"
	"time"
)

// The week of spend by subscription is summed once per subSpendTTL, and
// summed again after it.
func TestSubscriptionSpendIsKeptForItsTTL(t *testing.T) {
	ctx := context.Background()
	st := memStore(t)
	var c subSpendCache
	now := time.Now()
	if _, err := c.get(ctx, st, now); err != nil {
		t.Fatal(err)
	}
	first := c.at
	if _, err := c.get(ctx, st, now.Add(subSpendTTL-time.Second)); err != nil {
		t.Fatal(err)
	}
	if !c.at.Equal(first) {
		t.Fatalf("summed again within the TTL")
	}
	later := now.Add(subSpendTTL + time.Second)
	if _, err := c.get(ctx, st, later); err != nil {
		t.Fatal(err)
	}
	if !c.at.Equal(later) {
		t.Fatalf("not summed again after the TTL: at %v", c.at)
	}
}
