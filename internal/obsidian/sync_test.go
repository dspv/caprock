package obsidian

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

type fixture struct {
	t   *testing.T
	ctx context.Context
	st  *store.Store
	svc *Service
	now time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	f := &fixture{t: t, ctx: ctx, st: st, now: time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)}
	f.svc = &Service{Store: st, Now: func() time.Time { return f.now }}
	return f
}

func (f *fixture) exec(q string, args ...any) {
	f.t.Helper()
	if _, err := f.st.DB().ExecContext(f.ctx, q, args...); err != nil {
		f.t.Fatal(err)
	}
}

// write puts a note in a vault with a modification time a step later than
// the last, so a refresh sees it changed.
var tick = time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

func write(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	tick = tick.Add(time.Minute)
	if err := os.Chtimes(p, tick, tick); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) node(title string) store.BrainNode {
	f.t.Helper()
	var id int64
	if err := f.st.DB().QueryRowContext(f.ctx, `SELECT id FROM brain_nodes WHERE norm = ? AND kind NOT IN ('topic','person','project') ORDER BY id LIMIT 1`,
		store.NormTitle(title)).Scan(&id); err != nil {
		f.t.Fatalf("no node %q: %v", title, err)
	}
	n, err := store.GetBrainNode(f.ctx, f.st.DB(), id)
	if err != nil {
		f.t.Fatal(err)
	}
	return n
}

func (f *fixture) has(title string) bool {
	var n int
	_ = f.st.DB().QueryRowContext(f.ctx, `SELECT COUNT(*) FROM brain_nodes WHERE norm = ?`, store.NormTitle(title)).Scan(&n)
	return n > 0
}

func (f *fixture) entity(kind, title string) int64 {
	id, err := store.BrainEntityByNorm(f.ctx, f.st.DB(), kind, store.NormTitle(title))
	if err != nil {
		f.t.Fatal(err)
	}
	return id
}

func (f *fixture) edge(from, to int64, kind string) bool {
	var n int
	_ = f.st.DB().QueryRowContext(f.ctx, `SELECT COUNT(*) FROM brain_edges WHERE src = ? AND dst = ? AND kind = ?`, from, to, kind).Scan(&n)
	return n > 0
}

func (f *fixture) count(q string, args ...any) int {
	f.t.Helper()
	var n int
	if err := f.st.DB().QueryRowContext(f.ctx, q, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func TestImportMergeRules(t *testing.T) {
	f := newFixture(t)
	db := f.st.DB()
	// What Second Brain had before: a decision in caprock, a topic, a project.
	f.exec(`INSERT INTO projects (root, name, added_at) VALUES ('/src/caprock', 'caprock', 1)`)
	wal, _, err := store.InsertBrainNode(f.ctx, db, store.BrainNode{Kind: store.BrainDecision, Title: "Use WAL mode", Summary: "Chosen by a session.", Source: store.BrainSource{Project: "caprock"}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	ml, err := store.EnsureBrainEntity(f.ctx, db, store.BrainTopic, "machine learning", store.BrainSource{}, true, 0, 1)
	if err != nil {
		t.Fatal(err)
	}

	a := t.TempDir()
	write(t, a, "caprock/Use WAL mode.md", "Readers do not block. #sqlite")
	write(t, a, "ideas/Graph view.md", "---\naliases: [Knowledge graph]\n---\nDraw it. [[SQLite]] [[Missing note]] #machine-learning")
	write(t, a, "SQLite.md", "An engine. #sqlite See [[Graph view#Layout]].")
	write(t, a, "caprock/Plan.md", "The plan for caprock.")
	write(t, a, ".obsidian/workspace.md", "[[SQLite]]")
	write(t, a, "attachments/pic.png", "png")

	va, r, err := f.svc.Add(f.ctx, a, false)
	if err != nil {
		t.Fatal(err)
	}
	if r.Notes != 4 || r.Added != 4 || r.Merged != 1 || va.Notes != 4 || va.Name != filepath.Base(a) || va.Agents {
		t.Fatalf("first import: %+v, vault %+v", r, va)
	}
	if _, _, err := f.svc.Add(f.ctx, a, false); !errors.Is(err, store.ErrVaultExists) {
		t.Fatalf("second add of the same folder: %v", err)
	}

	// A note becomes a note node under the Obsidian cluster, or the project
	// its folder is named after; a title that names a memory joins it.
	gv, sq, plan := f.node("Graph view"), f.node("SQLite"), f.node("Plan")
	if gv.Kind != store.BrainNote || gv.Source.Project != store.BrainCluster || gv.Summary == "" {
		t.Fatalf("graph view: %+v", gv)
	}
	if plan.Source.Project != "caprock" || sq.Source.Project != store.BrainCluster {
		t.Fatalf("projects: plan %q, sqlite %q", plan.Source.Project, sq.Source.Project)
	}
	if got := f.node("Use WAL mode"); got.ID != wal.ID || got.Kind != store.BrainDecision || got.Summary != "Chosen by a session." {
		t.Fatalf("merged memory changed: %+v", got)
	}
	if n := f.count(`SELECT COUNT(*) FROM brain_nodes WHERE kind = 'note'`); n != 3 {
		t.Fatalf("%d note nodes, want 3", n)
	}
	if f.has("workspace") || f.has("pic") {
		t.Fatal(".obsidian or an attachment was imported")
	}

	// [[links]] are edges, unresolved ones none; #tags are topics, an
	// existing topic reused ("machine-learning" joins "machine learning").
	if !f.edge(sq.ID, gv.ID, store.EdgeRelates) || !f.edge(gv.ID, sq.ID, store.EdgeRelates) {
		t.Fatal("links are not edges")
	}
	if f.has("Missing note") {
		t.Fatal("an unresolved link made a node")
	}
	sqliteTopic := f.entity(store.BrainTopic, "sqlite")
	if sqliteTopic == 0 || !f.edge(wal.ID, sqliteTopic, store.EdgePartOf) || !f.edge(sq.ID, sqliteTopic, store.EdgePartOf) {
		t.Fatal("tags are not topics")
	}
	if !f.edge(gv.ID, ml, store.EdgePartOf) || f.entity(store.BrainTopic, "machine-learning") != 0 {
		t.Fatal("an existing topic was not reused")
	}
	if !f.edge(plan.ID, f.entity(store.BrainProject, "caprock"), store.EdgePartOf) ||
		!f.edge(gv.ID, f.entity(store.BrainProject, store.BrainCluster), store.EdgePartOf) {
		t.Fatal("notes are not part of their project")
	}

	// A second vault: a note titled like the first vault's alias is one node
	// with two sources, each keeping its own text.
	b := t.TempDir()
	write(t, b, "Knowledge graph.md", "Another vault's words about graphs.")
	vb, r, err := f.svc.Add(f.ctx, b, false)
	if err != nil || r.Merged != 1 {
		t.Fatalf("second vault: %+v %v", r, err)
	}
	srcs, err := store.BrainNodeSources(f.ctx, db, gv.ID)
	if err != nil || len(srcs) != 2 || srcs[0].Vault != va.Name || srcs[1].Vault != vb.Name ||
		srcs[1].Excerpt != "Another vault's words about graphs." || srcs[0].Excerpt == srcs[1].Excerpt {
		t.Fatalf("sources: %+v %v", srcs, err)
	}
	if got := f.node("Graph view"); got.Summary != gv.Summary {
		t.Fatalf("summary glued: %q", got.Summary)
	}
	// Search finds a node by any source's words, and the graph marks it.
	g, err := store.ReadBrainGraph(f.ctx, db, store.BrainFilter{Query: "another vault"})
	if err != nil || len(g.Nodes) == 0 || g.Nodes[0].ID != gv.ID || g.Nodes[0].Vault != va.Name {
		t.Fatalf("search: %+v %v", g.Nodes, err)
	}

	// The handoff and the extraction's topics leave a vault out until the
	// user lets its notes reach agents.
	pick, err := store.BrainHandoff(f.ctx, db, "caprock")
	if err != nil {
		t.Fatal(err)
	}
	mems := slices.Concat(pick.Decisions, pick.Memories)
	if slices.ContainsFunc(mems, func(n store.BrainNode) bool { return n.ID == plan.ID }) || !slices.ContainsFunc(mems, func(n store.BrainNode) bool { return n.ID == wal.ID }) {
		t.Fatalf("handoff with agents off: %+v", mems)
	}
	titles, _ := store.BrainEntityTitles(f.ctx, db, store.BrainTopic, 60)
	if slices.Contains(titles, "sqlite") || !slices.Contains(titles, "machine learning") {
		t.Fatalf("topics sent with agents off: %q", titles)
	}
	if _, err := f.svc.SetAgents(f.ctx, va.ID, true); err != nil {
		t.Fatal(err)
	}
	pick, _ = store.BrainHandoff(f.ctx, db, "caprock")
	mems = slices.Concat(pick.Decisions, pick.Memories)
	if !slices.ContainsFunc(mems, func(n store.BrainNode) bool { return n.ID == plan.ID }) {
		t.Fatalf("handoff with agents on: %+v", mems)
	}
	titles, _ = store.BrainEntityTitles(f.ctx, db, store.BrainTopic, 60)
	if !slices.Contains(titles, "sqlite") {
		t.Fatalf("topics with agents on: %q", titles)
	}

	// Counts: notes are not memories.
	if n, _ := store.CountBrainMemories(f.ctx, db, false); n != 1 {
		t.Fatalf("memories %d, want 1", n)
	}

	// Removing the first vault takes its notes, edges and source marks and
	// nothing else: the decision stays as it was, the topic it made goes,
	// the topic it found stays, the second vault's node stays.
	if err := f.svc.Remove(f.ctx, va.ID); err != nil {
		t.Fatal(err)
	}
	if got := f.node("Use WAL mode"); got.ID != wal.ID || got.Summary != "Chosen by a session." {
		t.Fatalf("memory after remove: %+v", got)
	}
	if f.has("SQLite") || f.has("Plan") || f.entity(store.BrainTopic, "sqlite") != 0 {
		t.Fatal("the vault's notes or topic stayed")
	}
	if f.entity(store.BrainTopic, "machine learning") != ml {
		t.Fatal("a topic the vault found was removed")
	}
	kg := f.node("Knowledge graph")
	if kg.Kind != store.BrainNote || kg.Summary != "Another vault's words about graphs." {
		t.Fatalf("the other vault's node: %+v", kg)
	}
	if n := f.count(`SELECT COUNT(*) FROM brain_vault_notes WHERE vault_id = ?`, va.ID) + f.count(`SELECT COUNT(*) FROM brain_vault_edges WHERE vault_id = ?`, va.ID); n != 0 {
		t.Fatalf("%d rows of the removed vault", n)
	}
	if f.edge(wal.ID, sqliteTopic, store.EdgePartOf) {
		t.Fatal("the vault's edge on a memory stayed")
	}
	if err := f.svc.Remove(f.ctx, vb.ID); err != nil {
		t.Fatal(err)
	}
	if n := f.count(`SELECT COUNT(*) FROM brain_nodes WHERE vault_id IS NOT NULL OR kind = 'note'`); n != 0 {
		t.Fatalf("%d nodes left of removed vaults", n)
	}
}

func TestRefreshEditsDeletesRenames(t *testing.T) {
	f := newFixture(t)
	db := f.st.DB()
	a := t.TempDir()
	write(t, a, "A.md", "Alpha links [[B]] #one")
	write(t, a, "B.md", "Beta #one #two")
	write(t, a, "C.md", "Gamma links [[A]]")
	v, _, err := f.svc.Add(f.ctx, a, false)
	if err != nil {
		t.Fatal(err)
	}
	na, nb, nc := f.node("A"), f.node("B"), f.node("C")
	if !f.edge(na.ID, nb.ID, store.EdgeRelates) || !f.edge(nc.ID, na.ID, store.EdgeRelates) {
		t.Fatal("links")
	}

	// Nothing changed: nothing read, nothing linked, weights as they were.
	r := mustRefresh(t, f, v.ID)
	if r.Read != 0 || r.Linked != 0 || r.Unlinked != 0 {
		t.Fatalf("idle refresh: %+v", r)
	}
	if _, r, _ = f.svc.Refresh(f.ctx, v.ID, true); r.Read != 3 || r.Changed != 0 || r.Linked != 0 || r.Unlinked != 0 {
		t.Fatalf("forced idle refresh: %+v", r)
	}
	var w float64
	_ = db.QueryRowContext(f.ctx, `SELECT weight FROM brain_edges WHERE src = ? AND dst = ?`, na.ID, nb.ID).Scan(&w)
	if w != 1 {
		t.Fatalf("weight %v after refreshes, want 1", w)
	}

	// An edit: A drops its link and tag and gains an alias; its node stays.
	write(t, a, "A.md", "---\naliases: Alef\n---\nAlpha rewritten #three")
	r = mustRefresh(t, f, v.ID)
	if r.Read != 1 || r.Changed != 1 {
		t.Fatalf("edit: %+v", r)
	}
	if f.edge(na.ID, nb.ID, store.EdgeRelates) || f.entity(store.BrainTopic, "three") == 0 {
		t.Fatal("edit not applied")
	}
	// Its keys changed (an alias), so it was matched again; nothing else
	// answers to A or Alef, so it keeps its own node.
	if got := f.node("A"); got.ID != na.ID || got.Summary != "Alpha rewritten #three" {
		t.Fatalf("edited node: %+v", got)
	}
	// "one" is still B's; "two" too.
	if f.entity(store.BrainTopic, "one") == 0 {
		t.Fatal("a topic still used was removed")
	}
	// A plain edit keeps the node.
	cID := f.node("C").ID
	write(t, a, "C.md", "Gamma again, links [[Alef]]")
	mustRefresh(t, f, v.ID)
	if f.node("C").ID != cID || !f.edge(cID, f.node("A").ID, store.EdgeRelates) {
		t.Fatal("an alias link did not resolve, or the edited node changed")
	}

	// A delete: B goes, with its edges and the topic only it used.
	if err := os.Remove(filepath.Join(a, "B.md")); err != nil {
		t.Fatal(err)
	}
	r = mustRefresh(t, f, v.ID)
	if r.Removed != 1 || f.has("B") || f.entity(store.BrainTopic, "two") != 0 || f.entity(store.BrainTopic, "one") != 0 {
		t.Fatalf("delete: %+v", r)
	}

	// A rename: C becomes D; links to the old name stop resolving, the new
	// name resolves.
	if err := os.Rename(filepath.Join(a, "C.md"), filepath.Join(a, "D.md")); err != nil {
		t.Fatal(err)
	}
	write(t, a, "E.md", "Points at [[D]] and [[C]]")
	r = mustRefresh(t, f, v.ID)
	if f.has("C") || !f.has("D") || r.Removed != 1 || r.Added != 2 {
		t.Fatalf("rename: %+v", r)
	}
	if !f.edge(f.node("E").ID, f.node("D").ID, store.EdgeRelates) {
		t.Fatal("the renamed note is not linked")
	}

	// A folder that cannot be read is an error on the vault, not a vault
	// emptied.
	before := f.count(`SELECT COUNT(*) FROM brain_nodes WHERE kind = 'note'`)
	gone := a + "-moved"
	if err := os.Rename(a, gone); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.svc.Refresh(f.ctx, v.ID, false); err == nil {
		t.Fatal("a missing folder scanned")
	}
	got, _ := store.GetBrainVault(f.ctx, db, v.ID)
	if got.Error == "" || f.count(`SELECT COUNT(*) FROM brain_nodes WHERE kind = 'note'`) != before {
		t.Fatalf("missing folder: %+v", got)
	}
	_ = os.Rename(gone, a)
	if _, _, err := f.svc.Refresh(f.ctx, v.ID, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.GetBrainVault(f.ctx, db, v.ID); got.Error != "" {
		t.Fatalf("error kept after a good scan: %q", got.Error)
	}
}

func TestDuplicateTitlesInOneVaultAreOneNode(t *testing.T) {
	f := newFixture(t)
	a := t.TempDir()
	write(t, a, "work/Ideas.md", "Work ideas.")
	write(t, a, "home/Ideas.md", "Home ideas.")
	if _, _, err := f.svc.Add(f.ctx, a, false); err != nil {
		t.Fatal(err)
	}
	n := f.node("Ideas")
	srcs, _ := store.BrainNodeSources(f.ctx, f.st.DB(), n.ID)
	if f.count(`SELECT COUNT(*) FROM brain_nodes WHERE kind = 'note'`) != 1 || len(srcs) != 2 {
		t.Fatalf("one node with two sources: %+v", srcs)
	}
	// Deleting the first source hands the node to the second.
	if err := os.Remove(filepath.Join(a, "home", "Ideas.md")); err != nil {
		t.Fatal(err)
	}
	mustRefresh(t, f, 1)
	if got := f.node("Ideas"); got.ID != n.ID || got.Summary != "Work ideas." {
		t.Fatalf("after the first source went: %+v", got)
	}
}

func TestCleanPath(t *testing.T) {
	if _, err := CleanPath("relative/vault"); !errors.Is(err, ErrNotAbsolute) {
		t.Fatalf("relative: %v", err)
	}
	if _, err := CleanPath(filepath.Join(t.TempDir(), "nope")); !errors.Is(err, ErrNotFolder) {
		t.Fatalf("missing: %v", err)
	}
	d := t.TempDir()
	if got, err := CleanPath(d + string(filepath.Separator)); err != nil || got != filepath.Clean(d) {
		t.Fatalf("clean: %q %v", got, err)
	}
}

func mustRefresh(t *testing.T, f *fixture, id int64) Result {
	t.Helper()
	_, r, err := f.svc.Refresh(f.ctx, id, false)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// A file replaced by a symlink between discovery and reading must not read outside the vault.
func TestReadNoteCannotEscapeVault(t *testing.T) {
	vault, outside := t.TempDir(), t.TempDir()
	target := filepath.Join(outside, "secret.md")
	if err := os.WriteFile(target, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(vault, "Note.md")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := readNote(vault, "Note.md"); err == nil {
		t.Fatal("read outside the vault through a symlink")
	}
	if _, err := readNote(vault, filepath.Join("..", filepath.Base(outside), "secret.md")); err == nil {
		t.Fatal("read a parent path")
	}
}

func TestManualRefreshReadsAnEditWithUnchangedMetadata(t *testing.T) {
	f := newFixture(t)
	dir := t.TempDir()
	file := filepath.Join(dir, "Note.md")
	if err := os.WriteFile(file, []byte("First text"), 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	v, _, err := f.svc.Add(f.ctx, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("Other text"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(file, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.svc.Refresh(f.ctx, v.ID, true); err != nil {
		t.Fatal(err)
	}
	if got := f.node("Note"); got.Summary != "Other text" {
		t.Fatalf("manual refresh missed an edit: %+v", got)
	}
}

func TestVaultWalkStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Walk(ctx, t.TempDir()); !errors.Is(err, context.Canceled) {
		t.Fatalf("walk: %v", err)
	}
}

func TestAnIndependentLinkAddedAfterImportSurvivesRemoval(t *testing.T) {
	f := newFixture(t)
	node, _, err := store.InsertBrainNode(f.ctx, f.st.DB(), store.BrainNode{Kind: store.BrainDecision, Title: "Existing decision"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	write(t, dir, "Existing decision.md", "The source. #adopted-topic")
	v, _, err := f.svc.Add(f.ctx, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	topic := f.entity(store.BrainTopic, "adopted-topic")
	if err := f.st.WithTx(f.ctx, func(q store.Querier) error { return store.LinkBrain(f.ctx, q, node.ID, topic, store.EdgePartOf, 1, 2) }); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Remove(f.ctx, v.ID); err != nil {
		t.Fatal(err)
	}
	if !f.edge(node.ID, topic, store.EdgePartOf) {
		t.Fatal("removing the import removed an independently adopted link")
	}
}
