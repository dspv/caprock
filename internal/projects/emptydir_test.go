package projects

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// An empty folder is a free destination, as it is for git itself: the Add
// project sheet says "exists, empty — will clone here", and the clone must
// then not refuse it. A folder holding anything, a hidden file included, is
// still refused before git runs.
func TestCloneIntoAnEmptyFolderOnly(t *testing.T) {
	parent := t.TempDir()
	if err := os.Mkdir(filepath.Join(parent, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(parent, "full"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(parent, "full", ".DS_Store"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if !EmptyDir(filepath.Join(parent, "empty")) || EmptyDir(filepath.Join(parent, "full")) || EmptyDir(filepath.Join(parent, "missing")) {
		t.Fatal("EmptyDir misjudged a folder")
	}
	s, _, _ := newService(t)
	start(t, s)
	if _, _, err := s.Clone("op-empty", "https://example.invalid/src", parent, "empty"); err != nil {
		t.Fatalf("clone into an empty folder refused: %v", err)
	}
	if _, _, err := s.Clone("op-full", "https://example.invalid/src", parent, "full"); err == nil {
		t.Fatal("clone into a folder with a file in it was accepted")
	}
}

// ListedAt answers for the listed root and for a folder inside its
// repository — adding either returns that project — and not for a stranger.
func TestListedAtFindsTheProjectAddingWouldReturn(t *testing.T) {
	needGit(t)
	base := t.TempDir()
	repo := newRepo(t, filepath.Join(base, "repo"))
	sub := filepath.Join(repo, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	s, _, _ := newService(t)
	start(t, s)
	v, _, err := s.Add(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{repo, sub} {
		if p, ok := s.ListedAt(dir); !ok || p.ID != v.ID {
			t.Errorf("ListedAt(%s) = %+v %v, want project %d", dir, p, ok, v.ID)
		}
	}
	if _, ok := s.ListedAt(base); ok {
		t.Error("a folder that is no project was reported as listed")
	}
}
