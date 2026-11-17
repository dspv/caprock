package store

import (
	"context"
	"testing"
	"time"
)

// A branch keeps its latest push, a replay or an older push never moves it
// back, the list is newest first, and removing the session removes its rows.
func TestRecordPush(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	q := st.DB()
	must := func(sid, branch string, ts int64) {
		t.Helper()
		if err := RecordPush(ctx, q, sid, branch, ts); err != nil {
			t.Fatal(err)
		}
	}
	must("s", "feat/a", 100)
	must("s", "feat/b", 200)
	must("s", "feat/a", 300)
	must("s", "feat/a", 150) // older: kept at 300
	must("s", "", 400)       // no branch: nothing
	must("", "feat/c", 400)  // no session: nothing
	must("other", "feat/b", 900)
	got, err := SessionBranches(ctx, q, "s")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Branch != "feat/a" || got[0].PushedAt != 300 || got[1].Branch != "feat/b" || got[1].PushedAt != 200 {
		t.Fatalf("branches = %+v", got)
	}
	if err := UpsertSession(ctx, q, "s", SessionPatch{Cwd: "/w", StartedAt: 1, LastEventAt: 2}); err != nil {
		t.Fatal(err)
	}
	if _, err := RemoveSession(ctx, q, RemovalCandidate{SessionID: "s"}, time.UTC, 1000); err != nil {
		t.Fatal(err)
	}
	if got, _ := SessionBranches(ctx, q, "s"); len(got) != 0 {
		t.Fatalf("removed session kept %+v", got)
	}
	if got, _ := SessionBranches(ctx, q, "other"); len(got) != 1 {
		t.Fatalf("another session's push went too: %+v", got)
	}
}
