package store

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"
)

// Prices real loops out of a real database. Skipped unless CAPROCK_LIVE_DB is
// set, because it exists to check the query against data with the shapes only
// real transcripts have -- turns written before their own tool calls, hook
// events with no message id, models that changed rate mid-range.
func TestLiveLoopTax(t *testing.T) {
	path := os.Getenv("CAPROCK_LIVE_DB")
	if path == "" {
		t.Skip("set CAPROCK_LIVE_DB to run against a real database")
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()

	var sid string
	var n int
	if err := db.QueryRowContext(ctx, `
		SELECT session_id, COUNT(*) c FROM events
		WHERE kind='tool.pre' AND ts >= ?
		GROUP BY session_id ORDER BY c DESC LIMIT 1`,
		time.Now().Add(-48*time.Hour).UnixMilli()).Scan(&sid, &n); err != nil {
		t.Skipf("no recent tool calls: %v", err)
	}

	calls, unlinked, err := LoopTaxCalls(ctx, db, sid, time.Now().Add(-48*time.Hour), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("session %.8s: %d tool calls, %d priced, %d unlinked", sid, n, len(calls), unlinked)
	if len(calls) == 0 && unlinked == 0 {
		t.Fatal("a session with tool calls returned neither priced nor unlinked calls")
	}
	if len(calls) == 0 {
		t.Skipf("all %d calls arrived on the hook plane with no message id", unlinked)
	}
	var maxCtx int64
	for _, c := range calls {
		if c.Context <= 0 {
			t.Fatalf("a priced call with no context slipped through: %+v", c)
		}
		if c.Model == "" {
			t.Fatalf("a priced call with no model slipped through: %+v", c)
		}
		if c.Context > maxCtx {
			maxCtx = c.Context
		}
	}
	t.Logf("largest context at a call: %d tokens", maxCtx)
	// A real agentic session runs its calls in a big context; if the largest
	// reading is tiny the query is picking up the wrong turn.
	if maxCtx < 10_000 {
		t.Fatalf("largest context %d is implausibly small for a real session", maxCtx)
	}
}
