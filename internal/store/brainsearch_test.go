package store

import (
	"context"
	"fmt"
	"math/rand"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func searchTitles(t *testing.T, s *Store, q string) ([]string, BrainGraph) {
	t.Helper()
	g, err := ReadBrainGraph(context.Background(), s.db, BrainFilter{Query: q})
	if err != nil {
		t.Fatalf("search %q: %v", q, err)
	}
	var out []string
	for _, n := range g.Nodes {
		if !IsBrainEntity(n.Kind) {
			out = append(out, n.Title)
		}
	}
	return out, g
}

func TestFoldSearch(t *testing.T) {
	for in, want := range map[string]string{
		"ΑΘΗΝΑ":    "αθηνα",
		"Αθήνα":    "αθηνα",
		"ΟΔΟΣ":     "οδοσ", // the final sigma and the capital fold alike
		"οδός":     "οδοσ",
		"CAFÉ":     "cafe",
		"Crème":    "creme",
		"Ｗｉｄｅ":     "wide",
		"東京タワー":    "東京タワー",
		"İstanbul": "istanbul",
	} {
		if got := FoldSearch(in); got != want {
			t.Errorf("FoldSearch(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBrainSearchFindsAnyScriptInAnyCase(t *testing.T) {
	s := openTest(t)
	mustBrain(t, s, BrainNode{Kind: BrainDecision, Title: "Move the office to Αθήνα"})
	mustBrain(t, s, BrainNode{Kind: BrainFinding, Title: "The café on the corner", Summary: "Opens at 7"})
	mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "東京タワーの設計を見直す"})
	mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "Unrelated"})
	for q, want := range map[string]string{
		"ΑΘΗΝΑ":   "Move the office to Αθήνα",
		"αθηνα":   "Move the office to Αθήνα",
		"CAFE":    "The café on the corner",
		"Café":    "The café on the corner",
		"タワー":     "東京タワーの設計を見直す",
		"opens 7": "The café on the corner",
	} {
		got, _ := searchTitles(t, s, q)
		if len(got) != 1 || got[0] != want {
			t.Errorf("%q found %q, want [%q]", q, got, want)
		}
	}
}

func TestBrainSearchRanksMoreWordsFirstInAnyOrder(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	a := mustBrain(t, s, BrainNode{Kind: BrainDecision, Title: "Keep WAL mode", Summary: "readers never wait for the writer"})
	mustBrain(t, s, BrainNode{Kind: BrainDecision, Title: "Keep the cache small"})
	b := mustBrain(t, s, BrainNode{Kind: BrainFinding, Title: "Vacuum runs at night"})
	topic, _, _ := InsertBrainNode(ctx, s.db, BrainNode{Kind: BrainTopic, Title: "SQLite"}, 1)
	if err := LinkBrain(ctx, s.db, b.ID, topic.ID, EdgePartOf, 1, 1); err != nil {
		t.Fatal(err)
	}
	if got, _ := searchTitles(t, s, "writer keep"); len(got) != 2 || got[0] != a.Title {
		t.Errorf("two words, either order, the memory with both first: %q", got)
	}
	if got, _ := searchTitles(t, s, "keep vacuum"); len(got) != 3 || got[0] != b.Title {
		t.Errorf("any word matches, the rarer word first: %q", got)
	}
	if got, _ := searchTitles(t, s, "sqlite"); len(got) != 1 || got[0] != b.Title {
		t.Errorf("a linked topic's name counts: %q", got)
	}
}

// The measured failure (owner's database, 2026-10-22): "PR" matched 91% of
// memories through "project" and "prompt". A word matches whole words only.
func TestBrainSearchMatchesWholeWords(t *testing.T) {
	s := openTest(t)
	mustBrain(t, s, BrainNode{Kind: BrainDecision, Title: "Project layout stays flat", Summary: "the prompt said so"})
	mustBrain(t, s, BrainNode{Kind: BrainFinding, Title: "Merged the PR after CI", Summary: ""})
	mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "Open a draft pr, then ask"})
	got, _ := searchTitles(t, s, "PR")
	if len(got) != 2 || slices.Contains(got, "Project layout stays flat") {
		t.Errorf("PR found %q", got)
	}
	// A longer word may be the start of a word: "router" finds "routers".
	mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "Routers everywhere"})
	if got, _ := searchTitles(t, s, "router"); len(got) != 1 {
		t.Errorf("router found %q", got)
	}
	// Punctuation splits words in the query too.
	if got, _ := searchTitles(t, s, "(pr)"); len(got) != 2 {
		t.Errorf("(pr) found %q", got)
	}
	// A joined piece is a term of its own: the memory with all of it first.
	mustBrain(t, s, BrainNode{Kind: BrainFinding, Title: "Only read the cache once"})
	mustBrain(t, s, BrainNode{Kind: BrainDecision, Title: "The scout stays read-only"})
	if got, _ := searchTitles(t, s, "read-only"); len(got) != 2 || got[0] != "The scout stays read-only" {
		t.Errorf("read-only found %q", got)
	}
}

func TestBrainSearchSynonyms(t *testing.T) {
	s := openTest(t)
	mustBrain(t, s, BrainNode{Kind: BrainDecision, Title: "Show the cost of each pull request"})
	mustBrain(t, s, BrainNode{Kind: BrainFinding, Title: "Spend per PR is mostly cache reads"})
	mustBrain(t, s, BrainNode{Kind: BrainDecision, Title: "Rule: never push to master"})
	mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "Unrelated"})
	if got, _ := searchTitles(t, s, "PR"); len(got) != 2 {
		t.Errorf("pr finds pull request: %q", got)
	}
	if got, _ := searchTitles(t, s, "pull request"); len(got) != 2 {
		t.Errorf("pull request finds pr: %q", got)
	}
	if got, _ := searchTitles(t, s, "price"); len(got) != 2 {
		t.Errorf("price finds cost and spend: %q", got)
	}
	if got, _ := searchTitles(t, s, "decision"); len(got) != 1 || got[0] != "Rule: never push to master" {
		t.Errorf("decision finds rule: %q", got)
	}
	got, g := searchTitles(t, s, "cost per pull request")
	if len(got) < 2 || got[0] != "Show the cost of each pull request" {
		t.Errorf("cost per pull request: %q", got)
	}
	if !slices.Contains(g.Terms, "spend") || !slices.Contains(g.Terms, "pr") {
		t.Errorf("synonyms are marked too: %q", g.Terms)
	}
}

// A rare word outweighs a common one: in "hero cloud", "hero" is in one
// memory and "cloud" in many, so the one with "hero" comes first even
// though others have "cloud" in their titles.
func TestBrainSearchWeighsRareWordsMore(t *testing.T) {
	s := openTest(t)
	for i := 0; i < 8; i++ {
		mustBrain(t, s, BrainNode{Kind: BrainFinding, Title: fmt.Sprintf("Cloud note %d", i)})
	}
	mustBrain(t, s, BrainNode{Kind: BrainDecision, Title: "Landing copy", Summary: "the hero says no account and no cloud"})
	got, g := searchTitles(t, s, "hero cloud")
	if len(got) != 9 || got[0] != "Landing copy" {
		t.Errorf("hero cloud: %q", got)
	}
	if g.Nodes[0].Rank <= g.Nodes[1].Rank {
		t.Errorf("ranks: %d then %d", g.Nodes[0].Rank, g.Nodes[1].Rank)
	}
}

// Keywords weigh like the title, so an English query finds a memory whose
// title is in another language.
func TestBrainSearchMatchesKeywords(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	n, _, err := InsertBrainNode(ctx, s.db, BrainNode{Kind: BrainDecision, Title: "Η ομάδα πωλείται ως έτοιμο προϊόν",
		Keywords: []string{"teams", "sold as built", "pricing page"}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "Plain", Summary: "teams of two"})
	got, g := searchTitles(t, s, "Teams sold as built")
	if len(got) != 2 || got[0] != n.Title {
		t.Errorf("keywords: %q", got)
	}
	if len(g.Nodes[0].Keywords) != 3 {
		t.Errorf("keywords are returned: %q", g.Nodes[0].Keywords)
	}
	// An edit keeps them in the search.
	title := "Η ομάδα πωλείται"
	if _, err := UpdateBrainNode(ctx, s.db, n.ID, BrainPatch{Title: &title}, 2); err != nil {
		t.Fatal(err)
	}
	if got, _ := searchTitles(t, s, "pricing"); len(got) != 1 {
		t.Errorf("keywords after an edit: %q", got)
	}
}

// A superseded decision comes after every current match and says what
// replaced it.
func TestBrainSearchPutsSupersededLast(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	src := BrainSource{Project: "caprock"}
	old := mustBrain(t, s, BrainNode{Kind: BrainDecision, Title: "Price is five dollars a month for Premium", Source: src})
	mustBrain(t, s, BrainNode{Kind: BrainFinding, Title: "Premium buyers ask about teams", Source: src})
	cur := mustBrain(t, s, BrainNode{Kind: BrainDecision, Title: "Premium is 30 a year", Source: src})
	if err := BrainSupersede(ctx, s.db, cur.ID, old.ID, 5); err != nil {
		t.Fatal(err)
	}
	got, g := searchTitles(t, s, "premium price month")
	if len(got) != 3 || got[2] != old.Title {
		t.Errorf("order: %q", got)
	}
	if g.Nodes[2].SupersededBy != cur.ID || g.Nodes[0].SupersededBy != 0 {
		t.Errorf("superseded_by: %d %d", g.Nodes[2].SupersededBy, g.Nodes[0].SupersededBy)
	}
}

func TestBrainSearchToleratesSmallTypos(t *testing.T) {
	s := openTest(t)
	mustBrain(t, s, BrainNode{Kind: BrainDecision, Title: "Ship the release on Friday"})
	mustBrain(t, s, BrainNode{Kind: BrainDecision, Title: "Benchmarks before every decision", Summary: "measured on the owner's laptop"})
	mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "Cut the binary"})

	got, g := searchTitles(t, s, "relase")
	if len(got) != 1 || got[0] != "Ship the release on Friday" || !g.Close || !g.Nodes[0].Close {
		t.Errorf("one edit in a 6-letter word: %q close=%v", got, g.Close)
	}
	if !slices.Contains(g.Terms, "release") || !slices.Contains(g.Terms, "relase") {
		t.Errorf("terms to highlight: %q", g.Terms)
	}
	if got, _ := searchTitles(t, s, "bencmarsk"); len(got) != 1 {
		t.Errorf("two edits (a dropped letter, a swap) in a 9-letter word: %q", got)
	}
	if got, _ := searchTitles(t, s, "decisiom"); len(got) != 1 {
		t.Errorf("a typo of a word with an ending: %q", got)
	}
	if got, _ := searchTitles(t, s, "decisions"); len(got) != 1 {
		t.Errorf("another form of a word: %q", got)
	}
	if got, _ := searchTitles(t, s, "Sihp"); len(got) != 1 {
		t.Errorf("two letters swapped in the middle of a four-letter word: %q", got)
	}
	if got, _ := searchTitles(t, s, "cot"); len(got) != 0 {
		t.Errorf("a three-letter word must match exactly: %q", got)
	}
	if got, _ := searchTitles(t, s, "frxdxy"); len(got) != 0 {
		t.Errorf("two edits in a six-letter word is too far: %q", got)
	}
	_, g = searchTitles(t, s, "release")
	if g.Close || g.Nodes[0].Close {
		t.Error("an exact match is not a close one")
	}
}

func TestBrainSearchRanksTitleAboveSummaryAboveClose(t *testing.T) {
	s := openTest(t)
	// Inserted worst first, so the newest-first order would be wrong. Four
	// exact hits are few, so the close pass runs and finds "rooter".
	mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "Something about a router", Summary: ""})
	mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "Plain two", Summary: "the router is fine"})
	mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "Routers everywhere"})
	mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "Router first"})
	mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "Plain three", Summary: "a rooter is a different thing"})
	got, g := searchTitles(t, s, "router")
	want := []string{"Router first", "Something about a router", "Routers everywhere", "Plain two", "Plain three"}
	if !slices.Equal(got, want) {
		t.Errorf("order:\n got %q\nwant %q", got, want)
	}
	for i := 1; i < len(g.Nodes); i++ {
		if g.Nodes[i].Rank > g.Nodes[i-1].Rank {
			t.Errorf("rank not descending at %d: %d > %d", i, g.Nodes[i].Rank, g.Nodes[i-1].Rank)
		}
	}
	if g.Total != 5 || !g.Close || !g.Nodes[4].Close || g.Nodes[3].Close {
		t.Errorf("total %d close %v", g.Total, g.Close)
	}
}

func TestBrainSearchBackfillsRowsWithoutTheColumn(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	n := mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "Ölçüm ÇALIŞMASI"})
	if _, err := s.db.ExecContext(ctx, `UPDATE brain_nodes SET search = '' WHERE id = ?`, n.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := searchTitles(t, s, "olcum"); len(got) != 0 {
		t.Fatalf("an unfilled row cannot match: %q", got)
	}
	if err := s.backfillBrainSearch(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := searchTitles(t, s, "olcum calismasi"); len(got) != 1 {
		t.Errorf("after the backfill: %q", got)
	}
	// A change to the folding re-folds every row once.
	if _, err := s.db.ExecContext(ctx, `UPDATE brain_nodes SET search = 'stale'`); err != nil {
		t.Fatal(err)
	}
	if err := s.SetMeta(ctx, metaBrainSearchFold, "0"); err != nil {
		t.Fatal(err)
	}
	if err := s.backfillBrainSearch(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := searchTitles(t, s, "ölçüm"); len(got) != 1 {
		t.Errorf("after a re-fold: %q", got)
	}
	// An edit keeps it current.
	title := "Ein neuer Titel"
	if _, err := UpdateBrainNode(ctx, s.db, n.ID, BrainPatch{Title: &title}, 2); err != nil {
		t.Fatal(err)
	}
	if got, _ := searchTitles(t, s, "TITEL"); len(got) != 1 {
		t.Errorf("after an edit: %q", got)
	}
}

// fillBigBrain gives a store n memories with real-length titles and
// summaries in Latin and Greek letters, n/16 topics and three links each,
// and returns the searches to time: one word, two words, a project, a typo
// (the close pass, the expensive one, finds it) and a word nothing has (the
// close pass runs and finds nothing).
func fillBigBrain(ctx context.Context, s *Store, n int) ([]string, error) {
	rng := rand.New(rand.NewSource(1))
	alpha := []rune("abcdefghijklmnopqrstuvwxyzαβγδεζηθικλμνξοπρστυφχψω")
	vocab := make([]string, 3000)
	for i := range vocab {
		r := make([]rune, 3+rng.Intn(9))
		for j := range r {
			r[j] = alpha[rng.Intn(len(alpha))]
		}
		vocab[i] = string(r)
	}
	phrase := func(n int) string {
		w := make([]string, n)
		for i := range w {
			w[i] = vocab[rng.Intn(len(vocab))]
		}
		return strings.Join(w, " ")
	}
	err := s.WithTx(ctx, func(q Querier) error {
		var topics []int64
		for i := 0; i < n/16; i++ {
			n, _, err := InsertBrainNode(ctx, q, BrainNode{Kind: BrainTopic, Title: phrase(2)}, 1)
			if err != nil {
				return err
			}
			topics = append(topics, n.ID)
		}
		for i := 0; i < n; i++ {
			n, _, err := InsertBrainNode(ctx, q, BrainNode{Kind: BrainKinds[i%4], Title: phrase(6),
				Summary: phrase(40), Source: BrainSource{Project: fmt.Sprintf("project-%d", i%7)}}, int64(i))
			if err != nil {
				return err
			}
			for k := 0; k < 3; k++ {
				if err := LinkBrain(ctx, q, n.ID, topics[(i*7+k*13)%len(topics)], EdgePartOf, 1, 1); err != nil {
					return err
				}
			}
		}
		return nil
	})
	long := ""
	for _, w := range vocab {
		if utf8.RuneCountInString(w) >= 8 {
			long = w
			break
		}
	}
	typo := []rune(long)
	typo[2], typo[3] = typo[3], typo[2]
	return []string{vocab[0], vocab[0] + " " + vocab[1], "project-3", string(typo), "zzzzqqqq"}, err
}

// The screen searches as one types (debounced), so a search over a large
// brain has to stay a few milliseconds. The figures are in 03-contracts.md
// § Second Brain (BenchmarkBrainSearch, on an idle machine); the bound here
// is loose because CI machines are slow and shared.
func TestBrainSearchFiveThousandMemoriesQuickly(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a large brain")
	}
	if raceOn {
		// make pr-check runs -race on changed packages: a time budget is
		// not a time budget under the race detector (raceOn).
		t.Skip("times a query; meaningless under -race")
	}
	ctx := context.Background()
	s := openTest(t)
	queries, err := fillBigBrain(ctx, s, 5000)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range queries {
		f := BrainFilter{Query: q}
		_, _ = ReadBrainGraph(ctx, s.db, f)
		const runs = 5
		var best time.Duration
		var g BrainGraph
		for i := 0; i < runs; i++ {
			start := time.Now()
			g, err = ReadBrainGraph(ctx, s.db, f)
			if took := time.Since(start); i == 0 || took < best {
				best = took
			}
			if err != nil {
				t.Fatal(err)
			}
		}
		if best > 500*time.Millisecond {
			t.Errorf("%q took %v", q, best)
		}
		t.Logf("%q: %d matches (close %v), %d nodes, %d edges in %v", q, g.Total, g.Close, len(g.Nodes), len(g.Edges), best)
	}
}

// BenchmarkBrainSearch times the searches of fillBigBrain, the graph read
// included, against the same read with no search ("none"), at 1,000 and
// 5,000 memories:
//
//	go test ./internal/store -run '^$' -bench BrainSearch -benchtime 30x
func BenchmarkBrainSearch(b *testing.B) {
	ctx := context.Background()
	for _, n := range []int{1000, 5000} {
		s, err := Open(ctx, ":memory:", nil)
		if err != nil {
			b.Fatal(err)
		}
		queries, err := fillBigBrain(ctx, s, n)
		if err != nil {
			b.Fatal(err)
		}
		names := []string{"word", "two-words", "project", "typo", "nothing", "none"}
		for i, q := range append(queries, "") {
			b.Run(fmt.Sprintf("%d/%s", n, names[i]), func(b *testing.B) {
				f := BrainFilter{Query: q}
				for b.Loop() {
					if _, err := ReadBrainGraph(ctx, s.db, f); err != nil {
						b.Fatal(err)
					}
				}
			})
		}
		_ = s.Close()
	}
}
