package hive

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A fresh hive used to be three empty directories with no clue what belonged in
// them. The one place a user looks after running `caprock up --hive` has to
// explain itself, and the example has to be a task the board can actually parse
// — a broken example is worse than none.
func TestSeedWritesAReadmeAndAParsableExample(t *testing.T) {
	root := t.TempDir()
	h, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Seed(); err != nil {
		t.Fatal(err)
	}

	readme, err := os.ReadFile(filepath.Join(root, "README.md"))
	if err != nil {
		t.Fatalf("seeded hive has no README: %v", err)
	}
	// The three facts that decide whether anyone runs this.
	for _, want := range []string{"worktree", "done_criteria", "independent"} {
		if !strings.Contains(string(readme), want) {
			t.Errorf("the seeded README never mentions %q", want)
		}
	}

	task, err := h.GetTask(exampleTaskID)
	if err != nil {
		t.Fatalf("the seeded example task does not parse: %v", err)
	}
	if task.Status != StatusInbox {
		t.Errorf("example task status = %q, want %q", task.Status, StatusInbox)
	}
	if len(task.DoneCriteria) == 0 {
		t.Error("the example task has no done_criteria, so it demonstrates the one thing that matters least well")
	}
	if task.Body == "" {
		t.Error("the example task has no body")
	}
}

// Seed must never touch a hive someone is already using — including one whose
// example task they deliberately deleted.
func TestSeedNeverOverwritesAnExistingHive(t *testing.T) {
	root := t.TempDir()
	h, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Seed(); err != nil {
		t.Fatal(err)
	}
	readme := filepath.Join(root, "README.md")
	if err := os.WriteFile(readme, []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(h.taskPath(exampleTaskID)); err != nil {
		t.Fatal(err)
	}

	if err := h.Seed(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(readme); string(b) != "mine" {
		t.Fatalf("Seed overwrote an existing README: %q", string(b))
	}
	if _, err := os.Stat(h.taskPath(exampleTaskID)); err == nil {
		t.Fatal("Seed put back an example task the user had deleted")
	}
}
