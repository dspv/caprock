package daemon

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// The bulk reads behind /v1/status are reused for statusSlowTTL, then redone.
func TestSlowStatusIsReusedForItsTTL(t *testing.T) {
	d := &Daemon{log: quietLog(), store: memStore(t)}
	first := d.slowStatus().at
	if got := d.slowStatus().at; !got.Equal(first) {
		t.Fatalf("recomputed within the TTL: at %v, want the reused %v", got, first)
	}
	d.slowMu.Lock()
	d.slow.at = time.Now().Add(-statusSlowTTL - time.Second)
	stale := d.slow.at
	d.slowMu.Unlock()
	if got := d.slowStatus().at; !got.After(stale) {
		t.Fatalf("not recomputed after the TTL: at %v", got)
	}
}

// The handoff coverage stops at the first passage that answers each figure,
// and still counts what the one COUNT(DISTINCT) over every passage counted:
// projects with a long enough main-thread passage in range, the oldest of
// them, and none of the passages it must skip.
func TestHandoffCoverageCountsWhatItCounted(t *testing.T) {
	ctx := context.Background()
	st := memStore(t)
	db := st.DB()
	long := strings.Repeat("w", 450)
	sess := func(id, cwd string) {
		if err := store.UpsertSession(ctx, db, id, store.SessionPatch{Cwd: cwd}); err != nil {
			t.Fatal(err)
		}
	}
	turn := func(id, key, text string, ts int64, extra string) {
		p := `{"text":` + strconv.Quote(text) + extra + `}`
		if _, err := store.InsertEvent(ctx, db, &event.Event{SessionID: id, Source: event.SourceTranscript,
			Kind: event.KindTurnAssistant, Key: key, Ts: time.UnixMilli(ts), Payload: json.RawMessage(p)}); err != nil {
			t.Fatal(err)
		}
	}
	sess("a1", "/w/alpha")
	sess("a2", "/w/alpha")
	sess("b1", "/w/beta")
	sess("c1", "/w/gamma")
	sess("d1", "/w/delta")
	turn("a1", "1", "short", 1000, "")
	turn("a1", "2", long, 3000, "")
	turn("a2", "3", long, 2500, "")    // alpha again: one project
	turn("b1", "4", long, 900, "")     // before the range
	turn("b1", "5", long, 4000, "")    // beta, in range
	turn("c1", "6", "short", 5000, "") // gamma: nothing long enough
	turn("d1", "7", long, 2000, `,"sidechain":true`)
	repos, oldest, err := store.HandoffCoverage(ctx, db, 1000, 400)
	if err != nil {
		t.Fatal(err)
	}
	if repos != 2 || oldest != 2500 {
		t.Fatalf("coverage = %d repos since %d, want 2 since 2500", repos, oldest)
	}
	repos, oldest, err = store.HandoffCoverage(ctx, db, 9000, 400)
	if err != nil || repos != 0 || oldest != 0 {
		t.Fatalf("empty range = %d, %d, %v; want 0, 0", repos, oldest, err)
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
