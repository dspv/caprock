package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func mustBrain(t *testing.T, s *Store, n BrainNode) BrainNode {
	t.Helper()
	v, _, err := InsertBrainNode(context.Background(), s.db, n, time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("insert %q: %v", n.Title, err)
	}
	return v
}

func TestBrainEntitiesAreOnePerNormalizedTitle(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	a, created, err := InsertBrainNode(ctx, s.db, BrainNode{Kind: BrainTopic, Title: "SQLite"}, 1)
	if err != nil || !created {
		t.Fatalf("first topic: created=%v err=%v", created, err)
	}
	b, created, err := InsertBrainNode(ctx, s.db, BrainNode{Kind: BrainTopic, Title: "  sqlite. "}, 2)
	if err != nil || created {
		t.Fatalf("the same topic again must not be added: created=%v err=%v", created, err)
	}
	if a.ID != b.ID {
		t.Fatalf("got two topics %d and %d for one title", a.ID, b.ID)
	}
	// A person may share a topic's title; memories may share each other's.
	p := mustBrain(t, s, BrainNode{Kind: BrainPerson, Title: "SQLite"})
	if p.ID == a.ID {
		t.Fatal("a person and a topic are different entities")
	}
	m1 := mustBrain(t, s, BrainNode{Kind: BrainDecision, Title: "Keep SQLite"})
	m2 := mustBrain(t, s, BrainNode{Kind: BrainDecision, Title: "Keep SQLite"})
	if m1.ID == m2.ID {
		t.Fatal("two memories with one title are two memories")
	}
}

func TestBrainClipsTitleAndSummary(t *testing.T) {
	s := openTest(t)
	long := strings.Repeat("é", 200)
	n := mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: long, Summary: strings.Repeat("ü", 1000)})
	if got := len([]rune(n.Title)); got != BrainTitleRunes {
		t.Errorf("title is %d runes, want %d", got, BrainTitleRunes)
	}
	if got := len([]rune(n.Summary)); got != BrainSummaryRunes {
		t.Errorf("summary is %d runes, want %d", got, BrainSummaryRunes)
	}
	if _, _, err := InsertBrainNode(context.Background(), s.db, BrainNode{Kind: BrainIdea, Title: " . "}, 1); !errors.Is(err, ErrBrainInvalid) {
		t.Errorf("an empty title: err = %v, want ErrBrainInvalid", err)
	}
	if _, _, err := InsertBrainNode(context.Background(), s.db, BrainNode{Kind: "memo", Title: "x"}, 1); !errors.Is(err, ErrBrainInvalid) {
		t.Errorf("an unknown kind: err = %v, want ErrBrainInvalid", err)
	}
}

func TestBrainLinksStrengthenAndCap(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	m := mustBrain(t, s, BrainNode{Kind: BrainFinding, Title: "WAL helps"})
	topic := mustBrain(t, s, BrainNode{Kind: BrainTopic, Title: "sqlite"})
	for i := 0; i < 30; i++ {
		if err := LinkBrain(ctx, s.db, m.ID, topic.ID, EdgePartOf, 1, 1); err != nil {
			t.Fatal(err)
		}
	}
	if err := LinkBrain(ctx, s.db, m.ID, m.ID, EdgeRelates, 1, 1); err != nil {
		t.Fatalf("a self-link is ignored, not an error: %v", err)
	}
	links, err := BrainNeighbours(ctx, s.db, m.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(links) != 1 || links[0].Weight != BrainEdgeWeightMax || !links[0].Out || links[0].Node.ID != topic.ID {
		t.Fatalf("links = %+v, want one capped outgoing edge to the topic", links)
	}
	back, _ := BrainNeighbours(ctx, s.db, topic.ID, 0)
	if len(back) != 1 || back[0].Out {
		t.Fatalf("from the topic: %+v, want one incoming edge", back)
	}
}

func TestBrainDeleteTakesOrphanedTopicsWithIt(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	m := mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "an idea"})
	other := mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "another idea"})
	lonely := mustBrain(t, s, BrainNode{Kind: BrainTopic, Title: "only for the first"})
	shared := mustBrain(t, s, BrainNode{Kind: BrainTopic, Title: "shared"})
	byHand := mustBrain(t, s, BrainNode{Kind: BrainTopic, Title: "kept by hand", Manual: true})
	for _, l := range [][2]int64{{m.ID, lonely.ID}, {m.ID, shared.ID}, {other.ID, shared.ID}, {m.ID, byHand.ID}} {
		if err := LinkBrain(ctx, s.db, l[0], l[1], EdgePartOf, 1, 1); err != nil {
			t.Fatal(err)
		}
	}
	if err := DeleteBrainNode(ctx, s.db, m.ID); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		id   int64
		kept bool
	}{{lonely.ID, false}, {shared.ID, true}, {byHand.ID, true}, {other.ID, true}} {
		_, err := GetBrainNode(ctx, s.db, c.id)
		if kept := err == nil; kept != c.kept {
			t.Errorf("node %d kept=%v, want %v (err %v)", c.id, kept, c.kept, err)
		}
	}
	var edges int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM brain_edges`).Scan(&edges)
	if edges != 1 {
		t.Errorf("%d edges left, want 1 (other → shared)", edges)
	}
	if err := DeleteBrainNode(ctx, s.db, m.ID); !errors.Is(err, ErrBrainNotFound) {
		t.Errorf("deleting twice: %v, want ErrBrainNotFound", err)
	}
}

func TestBrainUpdateRefusesADuplicateEntity(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	mustBrain(t, s, BrainNode{Kind: BrainTopic, Title: "Go"})
	rust := mustBrain(t, s, BrainNode{Kind: BrainTopic, Title: "Rust"})
	title := "go"
	if _, err := UpdateBrainNode(ctx, s.db, rust.ID, BrainPatch{Title: &title}, 5); !errors.Is(err, ErrBrainDuplicate) {
		t.Fatalf("renaming onto an existing topic: %v", err)
	}
	pin, summary := true, "a summary"
	n, err := UpdateBrainNode(ctx, s.db, rust.ID, BrainPatch{Pinned: &pin, Summary: &summary}, 5)
	if err != nil || !n.Pinned || n.Summary != summary || n.Title != "Rust" || n.UpdatedAt != 5 {
		t.Fatalf("patch: %+v %v", n, err)
	}
}

func TestBrainGraphFiltersAndCarriesEntities(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	q := s.db
	mk := func(title, project string, at int64) BrainNode {
		n, _, err := InsertBrainNode(ctx, q, BrainNode{Kind: BrainDecision, Title: title, Source: BrainSource{Project: project}}, at)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	a := mk("Use WAL", "caprock", 100)
	b := mk("Use 100% of the cache", "site", 200)
	c := mk("Ship on Friday", "caprock", 300)
	topic, _, _ := InsertBrainNode(ctx, q, BrainNode{Kind: BrainTopic, Title: "sqlite"}, 50)
	proj, _, _ := InsertBrainNode(ctx, q, BrainNode{Kind: BrainProject, Title: "caprock"}, 50)
	lone, _, _ := InsertBrainNode(ctx, q, BrainNode{Kind: BrainTopic, Title: "nothing links here"}, 50)
	_ = LinkBrain(ctx, q, a.ID, topic.ID, EdgePartOf, 1, 1)
	_ = LinkBrain(ctx, q, topic.ID, proj.ID, EdgePartOf, 1, 1)
	_ = LinkBrain(ctx, q, c.ID, a.ID, EdgeFollows, 1, 1)

	g, err := ReadBrainGraph(ctx, q, BrainFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if g.Total != 3 || len(g.Nodes) != 6 || len(g.Edges) != 3 {
		t.Fatalf("whole graph: total %d, %d nodes, %d edges; want 3, 6, 3", g.Total, len(g.Nodes), len(g.Edges))
	}
	if g.Nodes[0].ID != c.ID {
		t.Errorf("newest first: got %q", g.Nodes[0].Title)
	}
	deg := map[int64]int{}
	for _, n := range g.Nodes {
		deg[n.ID] = n.Degree
	}
	if deg[a.ID] != 2 || deg[topic.ID] != 2 || deg[lone.ID] != 0 {
		t.Errorf("degrees: %v", deg)
	}

	g, _ = ReadBrainGraph(ctx, q, BrainFilter{Query: "100%"})
	if g.Total != 1 || len(g.Nodes) != 1 || g.Nodes[0].ID != b.ID {
		t.Errorf("a literal %% search: %+v", g)
	}
	g, _ = ReadBrainGraph(ctx, q, BrainFilter{Project: "caprock"})
	if g.Total != 2 {
		t.Errorf("project filter: total %d, want 2", g.Total)
	}
	for _, n := range g.Nodes {
		if n.ID == lone.ID || n.ID == b.ID {
			t.Errorf("project filter returned %q", n.Title)
		}
	}
	g, _ = ReadBrainGraph(ctx, q, BrainFilter{Since: 150, Until: 250})
	if g.Total != 1 || g.Nodes[0].ID != b.ID {
		t.Errorf("time filter: %+v", g)
	}
	g, _ = ReadBrainGraph(ctx, q, BrainFilter{Limit: 1})
	if g.Total != 3 {
		t.Errorf("total ignores the limit: %d", g.Total)
	}
	mems := 0
	for _, n := range g.Nodes {
		if !IsBrainEntity(n.Kind) {
			mems++
		}
	}
	if mems != 1 {
		t.Errorf("limit 1 returned %d memories", mems)
	}

	pin := true
	if _, err := UpdateBrainNode(ctx, q, a.ID, BrainPatch{Pinned: &pin}, 400); err != nil {
		t.Fatal(err)
	}
	g, _ = ReadBrainGraph(ctx, q, BrainFilter{Limit: 1})
	if g.Nodes[0].ID != a.ID {
		t.Errorf("a pinned memory comes first: got %q", g.Nodes[0].Title)
	}
}

func TestBrainNoteSourceReadsOnlyMainThreadProse(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	mustSession(t, s, "s", 1000)
	main := event.Event{SessionID: "s", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: time.UnixMilli(900), Key: "a",
		Payload: []byte(`{"text":"We keep WAL."}`)}
	side := event.Event{SessionID: "s", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: time.UnixMilli(901), Key: "b",
		Payload: []byte(`{"text":"subagent words","sidechain":true}`)}
	mainID, err := InsertEvent(ctx, s.db, &main)
	if err != nil {
		t.Fatal(err)
	}
	sideID, _ := InsertEvent(ctx, s.db, &side)
	src, text, err := BrainNoteSource(ctx, s.db, mainID)
	if err != nil || text != "We keep WAL." || src.SessionID != "s" || src.Ts != 900 || src.Project != "p" || src.EventID != mainID {
		t.Fatalf("main note: %+v %q %v", src, text, err)
	}
	if _, _, err := BrainNoteSource(ctx, s.db, sideID); !errors.Is(err, ErrBrainNotFound) {
		t.Errorf("a sidechain note: %v, want ErrBrainNotFound", err)
	}
}

// The screen reads the whole graph on open and on every search; on a 5,000
// memory graph that has to stay well under a frame budget's worth of waiting.
// The bound is loose (CI machines are slow and shared); the plan is what the
// indexes are for.
func TestBrainGraphReadsFiveThousandNodesQuickly(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a large graph")
	}
	if raceOn {
		// make pr-check runs -race on changed packages: a time budget is
		// not a time budget under the race detector (raceOn).
		t.Skip("times a query; meaningless under -race")
	}
	ctx := context.Background()
	s := openTest(t)
	err := s.WithTx(ctx, func(q Querier) error {
		var topics []int64
		for i := 0; i < 200; i++ {
			n, _, err := InsertBrainNode(ctx, q, BrainNode{Kind: BrainTopic, Title: fmt.Sprintf("topic %d", i)}, 1)
			if err != nil {
				return err
			}
			topics = append(topics, n.ID)
		}
		for i := 0; i < 5000; i++ {
			n, _, err := InsertBrainNode(ctx, q, BrainNode{Kind: BrainKinds[i%4], Title: fmt.Sprintf("memory %d", i),
				Summary: "what was decided and why", Source: BrainSource{Project: fmt.Sprintf("p%d", i%7)}}, int64(i))
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
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []BrainFilter{{}, {Query: "memory 49"}, {Project: "p3"}, {Since: 2500}} {
		// The second read: the screen's, after the first warmed the cache.
		_, _ = ReadBrainGraph(ctx, s.db, f)
		start := time.Now()
		g, err := ReadBrainGraph(ctx, s.db, f)
		took := time.Since(start)
		if err != nil {
			t.Fatal(err)
		}
		if len(g.Nodes) == 0 {
			t.Fatalf("%+v: empty graph", f)
		}
		if took > 500*time.Millisecond {
			t.Errorf("%+v took %v", f, took)
		}
		t.Logf("%+v: %d nodes, %d edges in %v", f, len(g.Nodes), len(g.Edges), took)
	}
}
