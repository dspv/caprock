package daemon

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// The bulk reads behind /v1/status are reused for statusSlowTTL, then redone.
func TestSlowStatusIsReusedForItsTTL(t *testing.T) {
	ctx := context.Background()
	st := memStore(t)
	d := &Daemon{log: quietLog(), store: st}
	insert := func(key string) {
		if _, err := store.InsertEvent(ctx, st.DB(), &event.Event{SessionID: "s", Source: event.SourceHook,
			Kind: event.KindToolPre, Key: key, Payload: json.RawMessage(`{}`)}); err != nil {
			t.Fatal(err)
		}
	}
	insert("a")
	if n := d.slowStatus().events; n != 1 {
		t.Fatalf("events = %d, want 1", n)
	}
	insert("b")
	if n := d.slowStatus().events; n != 1 {
		t.Fatalf("events = %d within the TTL, want the reused 1", n)
	}
	d.slowMu.Lock()
	d.slow.at = time.Now().Add(-statusSlowTTL - time.Second)
	d.slowMu.Unlock()
	if n := d.slowStatus().events; n != 2 {
		t.Fatalf("events = %d after the TTL, want 2", n)
	}
}

// The empty-text repair runs only when a start flagged it, and clears the flag.
func TestRepairEmptyTextRunsOnceWhenFlagged(t *testing.T) {
	ctx := context.Background()
	st := memStore(t)
	d := &Daemon{log: quietLog(), store: st}
	d.repairEmptyText(ctx) // not flagged: nothing to do, nothing recorded
	if v, _ := st.GetMeta(ctx, store.MetaEmptyTextRepairPending); v != "" {
		t.Fatalf("flag = %q on a database that never needed the repair", v)
	}
	if err := st.SetMeta(ctx, store.MetaEmptyTextRepairPending, "1"); err != nil {
		t.Fatal(err)
	}
	d.repairEmptyText(ctx)
	if v, _ := st.GetMeta(ctx, store.MetaEmptyTextRepairPending); v != "0" {
		t.Fatalf("flag = %q after the repair ran, want 0", v)
	}
}
