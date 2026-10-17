package projects

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// mkdirs makes each folder below base.
func mkdirs(t *testing.T, base string, dirs ...string) {
	t.Helper()
	for _, d := range dirs {
		if err := os.MkdirAll(filepath.Join(base, filepath.FromSlash(d)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

// A folder of repositories is found two levels deep and no deeper; a
// repository is not descended into, and hidden folders (.git's insides
// included) and dependency trees are skipped.
func TestFindReposStopsAtTwoLevels(t *testing.T) {
	base := t.TempDir()
	mkdirs(t, base,
		"api/.git",                       // level 1
		"api/sub/.git",                   // inside a repository: not a member
		"services/web/.git",              // level 2
		"services/deep/worker/.git",      // level 3: too deep
		"node_modules/pkg/.git",          // a dependency's checkout
		"web/node_modules/thing/.git",    // the same, one level down
		".hidden/repo/.git",              // a hidden folder
		"plain/notes",                    // not a repository
		"api/.git/modules/inner/.git",    // git's own insides
		"services/vendor/.git/objects/x", // a repository called vendor is skipped by name
	)
	if err := os.WriteFile(filepath.Join(base, "file.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, capped := FindRepos(base, ScanDepth)
	want := []string{filepath.Join(base, "api"), filepath.Join(base, "services", "web")}
	if capped || !slices.Equal(got, want) {
		t.Fatalf("found %v capped=%v; want %v", got, capped, want)
	}
}

// threeRepos is a folder holding three repositories, with the service
// started after them (Windows will not remove a folder a watcher holds).
func threeRepos(t *testing.T) (base string, repos []string) {
	t.Helper()
	needGit(t)
	base = filepath.Join(t.TempDir(), "work")
	for _, n := range []string{"api", "web", "infra"} {
		repos = append(repos, newRepo(t, filepath.Join(base, n)))
	}
	return base, repos
}

// Scan says what Add would do; AddMulti lists one project of the chosen
// repositories, folding in a repository that was listed on its own, and a
// session's activity goes to the project with a per-repository split.
func TestOneProjectOfSeveralRepositories(t *testing.T) {
	base, repos := threeRepos(t)
	s, st, _ := newService(t)
	start(t, s)
	ctx := context.Background()

	alone, _, err := s.Add(ctx, repos[0])
	if err != nil {
		t.Fatal(err)
	}
	scan, err := s.Scan(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	if scan.RepoRoot != "" || len(scan.Repos) != 3 {
		t.Fatalf("scan = %+v; want three repositories", scan)
	}
	if scan.Repos[0].Name != "api" || scan.Repos[0].ProjectID != alone.ID {
		t.Fatalf("scan's first = %+v; want api, listed as %d", scan.Repos[0], alone.ID)
	}
	if in, err := s.Scan(ctx, repos[1]); err != nil || in.RepoRoot == "" || len(in.Repos) != 0 {
		t.Fatalf("scan of a repository = %+v %v; want its root and nothing to choose", in, err)
	}

	if _, _, err := s.AddMulti(ctx, base, repos[:1]); err == nil {
		t.Fatal("one repository made a multi-repo project")
	}
	v, created, err := s.AddMulti(ctx, base, repos[:2])
	if err != nil || !created {
		t.Fatalf("add multi: %v created=%v", err, created)
	}
	if len(v.Repos) != 2 || v.Repos[0].Name != "api" || v.Repos[1].Name != "web" {
		t.Fatalf("repos = %+v", v.Repos)
	}
	list, _ := s.List(ctx)
	if len(list) != 1 || list[0].ID != v.ID {
		t.Fatalf("list = %+v; api's own project should be folded in", list)
	}

	// A session in a member, one in the folder itself and one in the
	// repository left out.
	session(t, st, "in-web", filepath.Join(repos[1], "src"))
	session(t, st, "in-root", base)
	session(t, st, "in-infra", repos[2])
	usd := 2.5
	if _, err := store.InsertEvent(ctx, st.DB(), &event.Event{SessionID: "in-web", Kind: event.KindTurnAssistant, Model: "claude-opus-4-1", CostUSD: &usd, Ts: time.Now()}); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Sessions.Total != 3 || got.CostToday != 2.5 {
		t.Fatalf("project sessions %+v cost %v; want 3 and 2.5 (members, the folder and the folder's other repository)", got.Sessions, got.CostToday)
	}
	byName := map[string]RepoView{}
	for _, r := range got.Repos {
		byName[r.Name] = r
	}
	if byName["web"].Sessions.Total != 1 || byName["web"].CostToday != 2.5 || byName["api"].Sessions.Total != 0 {
		t.Fatalf("per repository = %+v", got.Repos)
	}

	// The session's folder decides the project, members included.
	if p, ok := s.ProjectFor(store.NormalizeDir(filepath.Join(repos[1], "src"))); !ok || p.ID != v.ID {
		t.Fatalf("ProjectFor(web/src) = %+v %v", p, ok)
	}
	// An agent started in a member reaches the others; one started in the
	// folder already reaches them all.
	other := s.OtherRepos(store.NormalizeDir(repos[1]))
	if len(other) != 1 || !sameDir(other[0], repos[0]) {
		t.Fatalf("OtherRepos(web) = %v; want api", other)
	}
	if o := s.OtherRepos(store.NormalizeDir(base)); len(o) != 0 {
		t.Fatalf("OtherRepos(root) = %v; want none", o)
	}

	// Member git state arrives without a watcher.
	deadline := time.Now().Add(5 * time.Second)
	for {
		g, _ := s.Get(ctx, v.ID)
		if len(g.Repos) == 2 && g.Repos[0].Git != nil && g.Repos[0].Git.Branch == "main" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no git state for the members: %+v", g.Repos)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Editing: members are added and removed, a split lists each as its own
// project (an absorbed one comes back with its name), a merge makes one
// again. Nothing on disk is touched.
func TestEditSplitAndMerge(t *testing.T) {
	base, repos := threeRepos(t)
	s, _, _ := newService(t)
	start(t, s)
	ctx := context.Background()

	alone, _, err := s.Add(ctx, repos[0])
	if err != nil {
		t.Fatal(err)
	}
	name := "API service"
	if _, err := s.Update(ctx, alone.ID, Patch{Name: &name}); err != nil {
		t.Fatal(err)
	}
	v, _, err := s.AddMulti(ctx, base, repos[:2])
	if err != nil {
		t.Fatal(err)
	}
	all := append([]string(nil), repos...)
	v, err = s.Update(ctx, v.ID, Patch{Repos: &all})
	if err != nil || len(v.Repos) != 3 {
		t.Fatalf("add a member: %+v %v", v.Repos, err)
	}
	if _, err := s.SetRepos(ctx, v.ID, []string{base}); err == nil {
		t.Fatal("the project's own folder became one of its repositories")
	}

	split, err := s.Split(ctx, v.ID)
	if err != nil || len(split) != 3 {
		t.Fatalf("split: %d %v", len(split), err)
	}
	list, _ := s.List(ctx)
	if len(list) != 3 {
		t.Fatalf("after split, list = %+v", list)
	}
	names := map[string]bool{}
	for _, p := range list {
		names[p.Name] = true
		if len(p.Repos) != 0 {
			t.Fatalf("%s still has members", p.Name)
		}
	}
	if !names["API service"] || !names["web"] || !names["infra"] {
		t.Fatalf("names = %v; api should come back as it was named", names)
	}
	for _, r := range repos {
		if _, err := os.Stat(filepath.Join(r, "f")); err != nil {
			t.Fatalf("a split touched %s: %v", r, err)
		}
	}

	ids := []int64{list[0].ID, list[1].ID}
	merged, err := s.Merge(ctx, ids)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged.Repos) != 2 || merged.ID != list[0].ID || !sameDir(merged.Root, list[0].Root) {
		t.Fatalf("merged = %+v", merged)
	}
	merged, err = s.Merge(ctx, []int64{merged.ID, list[2].ID})
	if err != nil || len(merged.Repos) != 3 {
		t.Fatalf("merge into a multi-repo project: %+v %v", merged.Repos, err)
	}
	if after, _ := s.List(ctx); len(after) != 1 {
		t.Fatalf("after merges, list = %+v", after)
	}
}

// Repositories picked one by one make one project with no folder of its own
// (ADR-077): the first is its home repository — the root, where agents start
// — and a member like the rest; two such projects can come from one folder;
// the project menu adds a repository to a plain repository project; a split
// keeps the home repository's project.
func TestProjectOfChosenRepositories(t *testing.T) {
	base, repos := threeRepos(t)
	s, st, _ := newService(t)
	start(t, s)
	ctx := context.Background()

	if _, _, err := s.AddRepos(ctx, repos[:1], ""); err == nil {
		t.Fatal("one repository made a project of several")
	}
	web, _, err := s.Add(ctx, repos[1])
	if err != nil {
		t.Fatal(err)
	}
	// api is listed on its own too: it is folded in.
	if _, _, err := s.Add(ctx, repos[0]); err != nil {
		t.Fatal(err)
	}
	v, created, err := s.AddRepos(ctx, []string{repos[1], repos[0]}, "Suite")
	if err != nil {
		t.Fatal(err)
	}
	if created || v.ID != web.ID || !sameDir(v.Root, repos[1]) || v.Kind != store.ProjectKindRepo || v.Name != "Suite" {
		t.Fatalf("project = %+v created=%v; want web's own project, renamed, rooted at web", v, created)
	}
	if len(v.Repos) != 2 || v.Repos[0].Name != "api" || v.Repos[1].Name != "web" {
		t.Fatalf("repos = %+v; want api and web, the home repository among them", v.Repos)
	}
	// infra, from the same folder, is free for another project: no folder
	// was listed.
	other, _, err := s.Add(ctx, repos[2])
	if err != nil || other.ID == v.ID {
		t.Fatalf("infra: %+v %v", other, err)
	}
	if list, _ := s.List(ctx); len(list) != 2 {
		t.Fatalf("list = %+v; want Suite and infra", list)
	}
	session(t, st, "in-api", repos[0])
	session(t, st, "in-web", filepath.Join(repos[1], "src"))
	session(t, st, "outside", base)
	got, _ := s.Get(ctx, v.ID)
	if got.Sessions.Total != 2 {
		t.Fatalf("sessions = %+v; want the two repositories', not the folder's", got.Sessions)
	}
	if o := s.OtherRepos(store.NormalizeDir(repos[1])); len(o) != 1 || !sameDir(o[0], repos[0]) {
		t.Fatalf("OtherRepos(home) = %v; want api", o)
	}

	// Add a repository to a plain repository project: its own root joins.
	added, err := s.Update(ctx, other.ID, Patch{Repos: &[]string{repos[0]}})
	if err != nil || len(added.Repos) != 2 {
		t.Fatalf("add a repository: %+v %v", added.Repos, err)
	}
	if g, _ := s.Get(ctx, v.ID); len(g.Repos) != 0 {
		t.Fatalf("api moved to infra's project, so Suite is web alone, a plain project again: %+v", g.Repos)
	}
	split, err := s.Split(ctx, other.ID)
	if err != nil || len(split) != 2 {
		t.Fatalf("split: %+v %v", split, err)
	}
	if p, ok := s.Project(other.ID); !ok || !sameDir(filepath.FromSlash(p.Root), repos[2]) {
		t.Fatalf("the home repository's project left the list: %+v %v", p, ok)
	}
	if list, _ := s.List(ctx); len(list) != 3 {
		t.Fatalf("after split, list = %+v", list)
	}
}

// The members survive a restart, and a session in a member never lists the
// member as a project of its own.
func TestMembersOutliveARestart(t *testing.T) {
	base, repos := threeRepos(t)
	s, st, _ := newService(t)
	start(t, s)
	ctx := context.Background()
	v, _, err := s.AddMulti(ctx, base, repos)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()

	again := New(st, nil, s.Log)
	again.Eligible = hasGitDir
	start(t, again)
	session(t, st, "s1", repos[2])
	again.noteSession(ctx, mustSession(t, st, "s1"))
	list, _ := again.List(ctx)
	if len(list) != 1 || list[0].ID != v.ID || len(list[0].Repos) != 3 {
		t.Fatalf("after restart, list = %+v", list)
	}
}
