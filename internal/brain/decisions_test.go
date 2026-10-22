package brain

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// A read is shown the project's current decisions and recent memories with
// their ids. An answer that says a new decision supersedes a shown one is
// stored as a supersedes edge from the new to the old; ids it cites as
// related or contradicted become edges across reads; its keywords are kept
// and searched; a memory near one already kept is left out; and an id that
// was not shown touches nothing.
func TestAReadSupersedesLinksAndSkipsDuplicates(t *testing.T) {
	ctx := context.Background()
	var answer func() Result
	e := newEnv(t, func(Request) (Result, error) { return answer(), nil })
	db := e.st.DB()
	add := func(kind, title, project string) store.BrainNode {
		t.Helper()
		n, _, err := store.InsertBrainNode(ctx, db, store.BrainNode{Kind: kind, Title: title, Source: store.BrainSource{Project: project}}, 1)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	oldPrice := add("decision", "Premium costs five dollars a month", "acme-api")
	scout := add("finding", "Scout stays read-only", "acme-api")
	elsewhere := add("decision", "Another project's decision", "web")

	answer = func() Result {
		return Result{Memories: []Memory{
			{Kind: "decision", Title: "Premium costs thirty dollars a year", Summary: "Monthly billing churned.",
				Topics: []string{"pricing"}, Keywords: []string{"price", "premium", "subscription", "billing", "yearly"},
				Supersedes: []int64{oldPrice.ID, elsewhere.ID, 999}, RelatedIDs: []int64{scout.ID, elsewhere.ID}},
			{Kind: "finding", Title: "The scout stays read-only", Summary: "Again.", Topics: []string{"scout"}},
			{Kind: "finding", Title: "Cancellations doubled under monthly billing", Summary: "Measured.",
				Topics: []string{"pricing"}, Keywords: []string{"churn"}, ContradictsIDs: []int64{oldPrice.ID}},
		}}
	}
	e.session(t, "s1", "acme-api", 20*time.Minute, [2]string{"What should Premium cost?", long})
	if _, err := e.eng.Wake(ctx); err != nil {
		t.Fatal(err)
	}
	p := e.reqs[0].Prompt
	if !strings.Contains(p, fmt.Sprintf("#%d Premium costs five dollars a month", oldPrice.ID)) ||
		!strings.Contains(p, fmt.Sprintf("#%d finding: Scout stays read-only", scout.ID)) || strings.Contains(p, "Another project") {
		t.Errorf("the read is shown the project's decisions and memories:\n%s", p)
	}

	g, err := store.ReadBrainGraph(ctx, db, store.BrainFilter{Project: "acme-api"})
	if err != nil {
		t.Fatal(err)
	}
	byTitle := map[string]store.BrainNode{}
	for _, n := range g.Nodes {
		byTitle[n.Title] = n
	}
	if _, dup := byTitle["The scout stays read-only"]; dup {
		t.Error("a near duplicate of a kept memory was kept")
	}
	cur, ok := byTitle["Premium costs thirty dollars a year"]
	if !ok || len(cur.Keywords) != 5 {
		t.Fatalf("the new decision and its keywords: %+v", cur)
	}
	if byTitle[oldPrice.Title].SupersededBy != cur.ID {
		t.Errorf("superseded_by: %d, want %d", byTitle[oldPrice.Title].SupersededBy, cur.ID)
	}
	other, err := store.GetBrainNode(ctx, db, elsewhere.ID)
	if err != nil || other.SupersededBy != 0 {
		t.Errorf("an id that was not shown is untouched: %+v %v", other, err)
	}
	kinds := map[string]int{}
	for _, ed := range g.Edges {
		if ed.From == cur.ID && ed.To == scout.ID {
			kinds["relates-scout"]++
		}
		if ed.To == oldPrice.ID {
			kinds[ed.Kind]++
		}
	}
	if kinds["supersedes"] != 1 || kinds["contradicts"] != 1 || kinds["relates-scout"] != 1 {
		t.Errorf("edges across reads: %v", kinds)
	}
	decs, err := store.BrainCurrentDecisions(ctx, db, "acme-api", 30, false)
	if err != nil || len(decs) != 1 || decs[0].ID != cur.ID {
		t.Errorf("current decisions: %+v %v", decs, err)
	}
	// An English query finds it by its keywords.
	got, err := store.ReadBrainGraph(ctx, db, store.BrainFilter{Query: "subscription"})
	if err != nil || got.Total != 1 {
		t.Errorf("keywords searched: %d %v", got.Total, err)
	}
}

func TestTitlesNear(t *testing.T) {
	for _, c := range []struct {
		a, b string
		near bool
	}{
		{"Scout stays read-only", "The scout stays read-only", true},
		{"Scout stays read-only", "scout stays READ ONLY.", true},
		{"Price is 30", "Price is 40", false},
		{"Use SQLite", "Use SQLite for the session cache", false},
		{"Keep WAL mode on", "Keep WAL mode", true},
		{"東京タワー", "東京タワー", true},
		{"Café menu changes", "Cafe menu changes", true},
	} {
		if got := store.BrainTitlesNear(c.a, c.b); got != c.near {
			t.Errorf("%q ~ %q = %v, want %v", c.a, c.b, got, c.near)
		}
	}
}
