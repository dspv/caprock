package store

import (
	"context"
	"testing"
)

func TestRecordPR(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	q := st.DB()
	u := "https://github.com/o/r/pull/5"
	must := func(a PRAction) {
		t.Helper()
		if err := RecordPR(ctx, q, a); err != nil {
			t.Fatal(err)
		}
	}
	must(PRAction{SessionID: "s", URL: u, Number: 5, Title: "feat: x", Action: "created", Ts: 100})
	must(PRAction{SessionID: "s", URL: u, Number: 5, Title: "feat: x", Action: "created", Ts: 100}) // replayed
	must(PRAction{SessionID: "s", URL: u, Number: 5, Action: "edited", Ts: 150})                    // not recorded
	must(PRAction{SessionID: "s", Number: 5, Action: "closed", Ts: 200})                            // no URL: matched by number
	must(PRAction{SessionID: "s", Number: 6, Action: "closed", Ts: 210})                            // unknown PR: dropped
	prs, err := SessionPRs(ctx, q, "s")
	if err != nil {
		t.Fatal(err)
	}
	if len(prs) != 1 {
		t.Fatalf("prs = %+v", prs)
	}
	p := prs[0]
	if p.OpenedAt != 100 || p.ClosedAt != 200 || p.MergedAt != 0 || p.LastAt != 200 || p.Title != "feat: x" {
		t.Fatalf("pr = %+v", p)
	}
	// A merge recorded in another session (a coordinator merging a worker's
	// PR) is that session's row, not this one's.
	must(PRAction{SessionID: "boss", URL: u, Number: 5, Action: "merged", Ts: 300})
	prs, _ = SessionPRs(ctx, q, "s")
	if prs[0].MergedAt != 0 {
		t.Fatalf("merge leaked across sessions: %+v", prs[0])
	}
}
