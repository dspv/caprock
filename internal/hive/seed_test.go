package hive

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A fresh hive used to be three empty directories with no clue what belonged in
// them. The one place a user looks after running `caprock up --hive` has to
// explain itself — and it must not put work in the queue: an example task in
// tasks/ was shown as waiting and assigned by the orchestrator.
func TestSeedWritesAReadmeAndNoTask(t *testing.T) {
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
	// The three facts that decide whether anyone runs this, and the format.
	for _, want := range []string{"worktree", "done_criteria", "independent", "verify_rounds_used: 0"} {
		if !strings.Contains(string(readme), want) {
			t.Errorf("the seeded README never mentions %q", want)
		}
	}
	tasks, err := h.ListTasks()
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 0 {
		t.Fatalf("a fresh hive has %d tasks in its queue; want none", len(tasks))
	}
}

// The format shown in the README has to be one the board can parse — a broken
// example is worse than none.
func TestSeedExampleFormatParses(t *testing.T) {
	root := t.TempDir()
	h, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(h.taskPath("example-task"), []byte(exampleTask), 0o644); err != nil {
		t.Fatal(err)
	}
	task, err := h.GetTask("example-task")
	if err != nil {
		t.Fatalf("the README's example does not parse: %v", err)
	}
	if task.Status != StatusInbox || len(task.DoneCriteria) == 0 || task.Body == "" {
		t.Fatalf("example parsed as %+v", task)
	}
}

// Seed must never touch a hive someone is already using.
func TestSeedNeverOverwritesAnExistingHive(t *testing.T) {
	root := t.TempDir()
	h, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	readme := filepath.Join(root, "README.md")
	if err := os.WriteFile(readme, []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := h.Seed(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(readme); string(b) != "mine" {
		t.Fatalf("Seed overwrote an existing README: %q", string(b))
	}
}
