package projects

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

// A scan says which instruction files the repositories keep themselves,
// with the text of the scanned folder's (or its repository's) own, and a
// project lists its root's and each member's by name.
func TestInstructionFilesOnScanAndProject(t *testing.T) {
	base, repos := threeRepos(t)
	writeFile(t, filepath.Join(repos[0], "CLAUDE.md"), "Use the Makefile.\nNever npm.\n")
	writeFile(t, filepath.Join(repos[0], "AGENTS.md"), "Same as CLAUDE.md.\n")
	writeFile(t, filepath.Join(repos[2], ".claude", "CLAUDE.md"), "Terraform only.\n")
	// A folder named like one is not a file.
	if err := os.MkdirAll(filepath.Join(repos[1], "AGENTS.md"), 0o755); err != nil {
		t.Fatal(err)
	}
	s, _, _ := newService(t)
	start(t, s)
	ctx := context.Background()

	scan, err := s.Scan(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	if len(scan.InstructionFiles) != 0 {
		t.Fatalf("the folder has none of its own: %+v", scan.InstructionFiles)
	}
	got := map[string][]string{}
	for _, r := range scan.Repos {
		got[r.Name] = r.InstructionFiles
	}
	if !slices.Equal(got["api"], []string{"CLAUDE.md", "AGENTS.md"}) || got["web"] != nil || !slices.Equal(got["infra"], []string{".claude/CLAUDE.md"}) {
		t.Fatalf("found repos' files = %v", got)
	}

	// Inside a repository: its own files, with their text.
	in, err := s.Scan(ctx, repos[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(in.InstructionFiles) != 2 || in.InstructionFiles[0].Name != "CLAUDE.md" || in.InstructionFiles[0].Text != "Use the Makefile.\nNever npm.\n" {
		t.Fatalf("scan of api = %+v", in.InstructionFiles)
	}

	v, _, err := s.AddMulti(ctx, base, repos)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"api/CLAUDE.md", "api/AGENTS.md", "infra/.claude/CLAUDE.md"}
	if !slices.Equal(v.InstructionFiles, want) {
		t.Fatalf("project's files = %v; want %v", v.InstructionFiles, want)
	}
	writeFile(t, filepath.Join(base, "AGENTS.md"), "Root rules.\n")
	g, err := s.Get(ctx, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.InstructionFiles) != 4 || g.InstructionFiles[0] != "AGENTS.md" {
		t.Fatalf("after a root file = %v", g.InstructionFiles)
	}
}

// A long file is cut on a rune boundary and says so; one that is not text
// is left out.
func TestReadInstructionFilesCutsAndSkips(t *testing.T) {
	dir := t.TempDir()
	long := strings.Repeat("a", MaxInstructionBytes-1) + "é" + "tail"
	writeFile(t, filepath.Join(dir, "CLAUDE.md"), long)
	writeFile(t, filepath.Join(dir, "AGENTS.md"), "bin\x00ary")
	got := readInstructionFiles(dir)
	if len(got) != 1 || got[0].Name != "CLAUDE.md" || !got[0].Truncated {
		t.Fatalf("got %+v", got)
	}
	if len(got[0].Text) != MaxInstructionBytes-1 {
		t.Fatalf("cut at %d bytes; want the half rune dropped (%d)", len(got[0].Text), MaxInstructionBytes-1)
	}
}
