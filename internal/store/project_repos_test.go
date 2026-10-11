package store

import (
	"context"
	"slices"
	"testing"
)

// Migration 0050: a project's member repositories are stored in
// sessions.repo_root's form, a repository belongs to one project at a time,
// and an empty list makes the project an ordinary one again.
func TestProjectReposMoveAndClear(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	db := s.DB()
	a, _, err := InsertProject(ctx, db, Project{Root: "/work", Name: "work", Kind: ProjectKindFolder, Source: ProjectSourceFolder, AddedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := InsertProject(ctx, db, Project{Root: "/other", Name: "other", Kind: ProjectKindFolder, Source: ProjectSourceFolder, AddedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	set := func(id int64, paths ...string) []string {
		t.Helper()
		var got []string
		if err := s.WithTx(ctx, func(q Querier) error {
			var err error
			got, err = SetProjectRepos(ctx, q, id, paths, 2)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return got
	}
	if got := set(a.ID, `C:\work\web\`, "/work/api", "/work/api"); !slices.Equal(got, []string{"/work/api", "C:/work/web"}) {
		t.Fatalf("stored %v", got)
	}
	set(b.ID, "/work/api")
	all, err := ProjectRepos(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(all[a.ID], []string{"C:/work/web"}) || !slices.Equal(all[b.ID], []string{"/work/api"}) {
		t.Fatalf("after a move: %v", all)
	}
	set(a.ID)
	if all, _ := ProjectRepos(ctx, db); len(all[a.ID]) != 0 {
		t.Fatalf("after clearing: %v", all)
	}
	if err := s.WithTx(ctx, func(q Querier) error {
		_, err := SetProjectRepos(ctx, q, 404, []string{"/x"}, 3)
		return err
	}); err == nil {
		t.Fatal("members were set on a project that does not exist")
	}
}
