package store

import "testing"

// The batch is the newest open pull request that is not a release one and
// names a head branch; one not seen since `since` is too old to trust.
func TestBatchPR(t *testing.T) {
	st, ctx := openCostliest(t)
	pr := func(n int, title, head, state string) GitHubPR {
		return GitHubPR{Number: n, URL: "https://github.com/o/r/pull/" + string(rune('0'+n)), Title: title, Head: head, State: state, UpdatedAt: int64(n)}
	}
	if err := st.UpsertGitHubPRs(ctx, "o/r", []GitHubPR{
		pr(1, "feat: an old batch", "feat/old", "open"),
		pr(2, "fix: merged", "fix/m", "merged"),
		pr(3, "feat: the batch", "feat/batch", "open"),
		pr(4, "chore(release): 0.183.1", "release/0.183.1", "open"),
		pr(5, "no head", "", "open"),
	}, 1000); err != nil {
		t.Fatal(err)
	}
	p, ok, err := BatchPR(ctx, st.DB(), "O/R", 0)
	if err != nil || !ok || p.Number != 3 || p.Head != "feat/batch" {
		t.Fatalf("batch %+v ok %v err %v", p, ok, err)
	}
	if _, ok, _ := BatchPR(ctx, st.DB(), "o/r", 2000); ok {
		t.Fatal("a header not seen since was taken")
	}
	if _, ok, _ := BatchPR(ctx, st.DB(), "", 0); ok {
		t.Fatal("no repository read one")
	}
}
