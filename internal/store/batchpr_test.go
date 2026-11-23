package store

import (
	"strconv"
	"testing"
)

// The release vehicle is the newest open release pull request, else the
// newest open batch pull request; an ordinary feature pull request never is
// (owner, 2026-11-23: #1030, a feature PR, was read as the batch and its
// fragment made the next version a minor one). One not seen since `since`
// is too old to trust.
func TestBatchPR(t *testing.T) {
	st, ctx := openCostliest(t)
	pr := func(n int, title, head, state string) GitHubPR {
		return GitHubPR{Number: n, URL: "https://github.com/o/r/pull/" + strconv.Itoa(n), Title: title, Head: head, State: state, UpdatedAt: int64(n)}
	}
	if err := st.UpsertGitHubPRs(ctx, "o/r", []GitHubPR{
		pr(1, "feat: an old one", "batch/0.182.0", "open"),
		pr(2, "fix: merged", "fix/m", "merged"),
		pr(3, "feat: 0.183.0 batch — five things", "feat/batch-0183", "open"),
		pr(4, "feat(app): offline voice", "feat/offline-voice", "open"),
		pr(5, "no head", "", "open"),
	}, 1000); err != nil {
		t.Fatal(err)
	}
	p, ok, err := BatchPR(ctx, st.DB(), "O/R", 0)
	if err != nil || !ok || p.Number != 3 {
		t.Fatalf("batch %+v ok %v err %v", p, ok, err)
	}
	// A release pull request is the vehicle over any batch.
	if err := st.UpsertGitHubPRs(ctx, "o/r", []GitHubPR{pr(6, "chore(release): 0.183.1", "chore/release-0.183.1", "open")}, 1000); err != nil {
		t.Fatal(err)
	}
	if p, ok, _ := BatchPR(ctx, st.DB(), "o/r", 0); !ok || p.Number != 6 {
		t.Fatalf("release PR not taken: %+v ok %v", p, ok)
	}
	if _, ok, _ := BatchPR(ctx, st.DB(), "o/r", 2000); ok {
		t.Fatal("a header not seen since was taken")
	}
	if _, ok, _ := BatchPR(ctx, st.DB(), "", 0); ok {
		t.Fatal("no repository read one")
	}
}

// Feature pull requests alone: no vehicle.
func TestBatchPRFeatureOnly(t *testing.T) {
	st, ctx := openCostliest(t)
	if err := st.UpsertGitHubPRs(ctx, "o/r", []GitHubPR{
		{Number: 1030, URL: "https://github.com/o/r/pull/1030", Title: "feat(app): offline dictation on Windows and Linux", Head: "feat/offline-voice-win-linux", State: "open", UpdatedAt: 1},
		{Number: 1029, URL: "https://github.com/o/r/pull/1029", Title: "perf(store): batch the inserts", Head: "perf/batch-inserts", State: "open", UpdatedAt: 1},
	}, 1000); err != nil {
		t.Fatal(err)
	}
	if p, ok, err := BatchPR(ctx, st.DB(), "o/r", 0); err != nil || ok {
		t.Fatalf("a feature PR was taken for the vehicle: %+v ok %v err %v", p, ok, err)
	}
}

func TestIsReleaseBatchPR(t *testing.T) {
	for _, c := range []struct {
		title, head    string
		release, batch bool
	}{
		{"chore(release): 0.190.1", "chore/release-0.190.1", true, false},
		{"anything", "chore/release-0.190.1", true, false},
		{"release: v1.2.3", "rel", true, false},
		{"feat: Cursor support", "batch/0177", false, true},
		{"feat: 0.175.0 batch — compression", "feat/x", false, true},
		{"feat(app): offline voice", "feat/offline-voice", false, false},
		{"perf(store): batch the inserts", "perf/batch-inserts", false, false},
	} {
		if got := IsReleasePR(c.title, c.head); got != c.release {
			t.Errorf("IsReleasePR(%q, %q) = %v", c.title, c.head, got)
		}
		if got := IsBatchPR(c.title, c.head); got != c.batch {
			t.Errorf("IsBatchPR(%q, %q) = %v", c.title, c.head, got)
		}
	}
}
