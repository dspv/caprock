package hive

import (
	"fmt"
	"os"
	"strings"
)

// Task mirrors tasks/<id>.md (YAML frontmatter + free-form body). See
// .ai/05-orchestration.md § Task file. Statuses are the kanban columns.
type Task struct {
	ID               string   `yaml:"id" json:"id"`
	Title            string   `yaml:"title" json:"title"`
	Status           string   `yaml:"status" json:"status"`
	Assignee         string   `yaml:"assignee" json:"assignee"`
	BudgetUSD        float64  `yaml:"budget_usd" json:"budget_usd"`
	DoneCriteria     []string `yaml:"done_criteria" json:"done_criteria"`
	VerifyRoundsUsed int      `yaml:"verify_rounds_used" json:"verify_rounds_used"`
	Body             string   `yaml:"-" json:"body"`
}

// Task statuses (kanban columns).
const (
	StatusInbox      = "inbox"
	StatusAssigned   = "assigned"
	StatusInProgress = "in_progress"
	StatusVerifying  = "verifying"
	StatusNeedsYou   = "needs_you"
	StatusDone       = "done"
	StatusFailed     = "failed"
)

// allowedTransitions defines which status moves the board permits.
var allowedTransitions = map[string][]string{
	StatusInbox:      {StatusAssigned},
	StatusAssigned:   {StatusInProgress, StatusInbox},
	StatusInProgress: {StatusVerifying, StatusNeedsYou, StatusFailed},
	StatusVerifying:  {StatusDone, StatusInProgress, StatusNeedsYou},
	StatusNeedsYou:   {StatusInProgress, StatusAssigned, StatusFailed, StatusDone},
	StatusDone:       {},
	StatusFailed:     {StatusInbox},
}

// CanTransition reports whether from→to is an allowed board move.
func CanTransition(from, to string) bool {
	if from == to {
		return true
	}
	for _, s := range allowedTransitions[from] {
		if s == to {
			return true
		}
	}
	return false
}

// CreateTask writes a new task file in the inbox column and ledgers it.
func (h *Hive) CreateTask(t Task) error {
	if err := validID(t.ID); err != nil {
		return err
	}
	if t.Status == "" {
		t.Status = StatusInbox
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, err := os.Stat(h.taskPath(t.ID)); err == nil {
		return fmt.Errorf("hive: task %s already exists", t.ID)
	}
	if err := writeAtomic(h.taskPath(t.ID), []byte(marshalTask(t)), 0o644); err != nil {
		return err
	}
	return h.appendLedger(LedgerEntry{Kind: "task.created", TaskID: t.ID, To: t.Status})
}

// GetTask reads one task.
func (h *Hive) GetTask(id string) (Task, error) {
	b, err := os.ReadFile(h.taskPath(id))
	if err != nil {
		return Task{}, err
	}
	return parseTask(string(b))
}

// ListTasks returns all tasks sorted by id.
func (h *Hive) ListTasks() ([]Task, error) {
	names, err := listDir(joinTasks(h.Root))
	if err != nil {
		return nil, err
	}
	var out []Task
	for _, n := range names {
		if !strings.HasSuffix(n, ".md") {
			continue
		}
		t, err := h.GetTask(strings.TrimSuffix(n, ".md"))
		if err == nil {
			out = append(out, t)
		}
	}
	return out, nil
}

// UpdateTask applies a mutation under the lock, validating status transitions,
// and ledgers the change.
func (h *Hive) UpdateTask(id string, mut func(*Task) error) (Task, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	b, err := os.ReadFile(h.taskPath(id))
	if err != nil {
		return Task{}, err
	}
	t, err := parseTask(string(b))
	if err != nil {
		return Task{}, err
	}
	from := t.Status
	if err := mut(&t); err != nil {
		return Task{}, err
	}
	if t.Status != from && !CanTransition(from, t.Status) {
		return Task{}, fmt.Errorf("hive: illegal task transition %s → %s", from, t.Status)
	}
	if err := writeAtomic(h.taskPath(id), []byte(marshalTask(t)), 0o644); err != nil {
		return Task{}, err
	}
	if t.Status != from {
		_ = h.appendLedger(LedgerEntry{Kind: "task.status", TaskID: id, From: from, To: t.Status, Note: t.Assignee})
	}
	return t, nil
}

func joinTasks(root string) string { return root + string(os.PathSeparator) + "tasks" }
