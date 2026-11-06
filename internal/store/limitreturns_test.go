package store

import (
	"context"
	"testing"
)

// A return is kept across a reopen; restoring drops the stale ones and the
// ones whose session has ended or is unknown.
func TestLimitReturnsRestore(t *testing.T) {
	ctx := context.Background()
	db := openTest(t).DB()
	for _, id := range []string{"live", "stale", "ended"} {
		if err := UpsertSession(ctx, db, id, SessionPatch{Cwd: "/w"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`UPDATE sessions SET status = 'ended' WHERE session_id = 'ended'`); err != nil {
		t.Fatal(err)
	}
	for _, r := range []LimitReturn{
		{SessionID: "live", To: "default", At: 5000},
		{SessionID: "stale", To: "default", At: 100},
		{SessionID: "ended", To: "default", At: 5000},
		{SessionID: "unknown", To: "default", At: 5000},
	} {
		if err := SetLimitReturn(ctx, db, r); err != nil {
			t.Fatal(err)
		}
	}
	// A second move of the same session replaces its return.
	if err := SetLimitReturn(ctx, db, LimitReturn{SessionID: "live", To: "kimi", At: 6000}); err != nil {
		t.Fatal(err)
	}
	got, err := RestoreLimitReturns(ctx, db, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != (LimitReturn{SessionID: "live", To: "kimi", At: 6000}) {
		t.Fatalf("restored %+v", got)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM limit_returns`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("%d rows left (%v)", n, err)
	}
	if err := DeleteLimitReturn(ctx, db, "live"); err != nil {
		t.Fatal(err)
	}
	if got, _ := RestoreLimitReturns(ctx, db, 0); len(got) != 0 {
		t.Fatalf("after delete: %+v", got)
	}
}
