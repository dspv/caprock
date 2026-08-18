package store

import (
	"context"
	"database/sql"
	"errors"
)

// TaskRow mirrors the tasks table (a query cache over the hive's task files).
type TaskRow struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Status       string  `json:"status"`
	Assignee     string  `json:"assignee"`
	BudgetUSD    float64 `json:"budget_usd"`
	VerifyRounds int     `json:"verify_rounds"`
	CostUSD      float64 `json:"cost_usd"`
	CreatedAt    int64   `json:"created_at"`
	UpdatedAt    int64   `json:"updated_at"`
}

// UpsertTask mirrors a hive task into SQLite.
func UpsertTask(ctx context.Context, q Querier, t TaskRow) error {
	if t.CreatedAt == 0 {
		t.CreatedAt = nowMs()
	}
	t.UpdatedAt = nowMs()
	_, err := q.ExecContext(ctx, `
		INSERT INTO tasks(id, title, status, assignee, budget_usd, verify_rounds, cost_usd, created_at, updated_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  title = excluded.title, status = excluded.status, assignee = excluded.assignee,
		  budget_usd = excluded.budget_usd, verify_rounds = excluded.verify_rounds,
		  updated_at = excluded.updated_at`,
		t.ID, t.Title, t.Status, nullStr(t.Assignee), t.BudgetUSD, t.VerifyRounds, t.CostUSD, t.CreatedAt, t.UpdatedAt)
	return err
}

// ListTasks returns all task rows ordered by creation.
func ListTasks(ctx context.Context, q Querier) ([]TaskRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, COALESCE(title,''), status, COALESCE(assignee,''), COALESCE(budget_usd,0), verify_rounds, cost_usd, created_at, updated_at FROM tasks ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TaskRow
	for rows.Next() {
		var t TaskRow
		if err := rows.Scan(&t.ID, &t.Title, &t.Status, &t.Assignee, &t.BudgetUSD, &t.VerifyRounds, &t.CostUSD, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetTask returns one task row.
func GetTask(ctx context.Context, q Querier, id string) (TaskRow, error) {
	var t TaskRow
	err := q.QueryRowContext(ctx, `SELECT id, COALESCE(title,''), status, COALESCE(assignee,''), COALESCE(budget_usd,0), verify_rounds, cost_usd, created_at, updated_at FROM tasks WHERE id = ?`, id).
		Scan(&t.ID, &t.Title, &t.Status, &t.Assignee, &t.BudgetUSD, &t.VerifyRounds, &t.CostUSD, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

// IncForcedContinue bumps and returns the forced-continue count for (session, task).
func IncForcedContinue(ctx context.Context, q Querier, sessionID, taskID string) (int, error) {
	if _, err := q.ExecContext(ctx, `
		INSERT INTO forced_continues(session_id, task_id, count) VALUES(?, ?, 1)
		ON CONFLICT(session_id, task_id) DO UPDATE SET count = count + 1`, sessionID, taskID); err != nil {
		return 0, err
	}
	var n int
	err := q.QueryRowContext(ctx, `SELECT count FROM forced_continues WHERE session_id = ? AND task_id = ?`, sessionID, taskID).Scan(&n)
	return n, err
}

// ResetForcedContinue clears the counter (task moved on).
func ResetForcedContinue(ctx context.Context, q Querier, sessionID, taskID string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM forced_continues WHERE session_id = ? AND task_id = ?`, sessionID, taskID)
	return err
}

// RecordVerification stores one verification-command result.
func RecordVerification(ctx context.Context, q Querier, taskID string, round int, command string, exitCode int, outputPath string) error {
	_, err := q.ExecContext(ctx, `
		INSERT INTO verifications(task_id, round, command, exit_code, output_path, ts) VALUES(?, ?, ?, ?, ?, ?)
		ON CONFLICT(task_id, round, command) DO UPDATE SET exit_code = excluded.exit_code, output_path = excluded.output_path, ts = excluded.ts`,
		taskID, round, command, exitCode, nullStr(outputPath), nowMs())
	return err
}

// OpenAssignment records that a session started working a task at from_ts.
func OpenAssignment(ctx context.Context, q Querier, taskID, sessionID string, fromTs int64) error {
	_, err := q.ExecContext(ctx, `INSERT OR IGNORE INTO task_assignments(task_id, session_id, from_ts) VALUES(?, ?, ?)`, taskID, sessionID, fromTs)
	return err
}

// CloseAssignment closes the open window for a task/session at to_ts.
func CloseAssignment(ctx context.Context, q Querier, taskID, sessionID string, toTs int64) error {
	_, err := q.ExecContext(ctx, `UPDATE task_assignments SET to_ts = ? WHERE task_id = ? AND session_id = ? AND to_ts IS NULL`, toTs, taskID, sessionID)
	return err
}

// AttributeTaskCost sums event cost within a task's assignment windows and writes
// it to tasks.cost_usd (T24).
func AttributeTaskCost(ctx context.Context, q Querier, taskID string) (float64, error) {
	var cost sql.NullFloat64
	err := q.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(e.cost_usd), 0) FROM task_assignments a
		JOIN events e ON e.session_id = a.session_id
		 AND e.ts >= a.from_ts AND (a.to_ts IS NULL OR e.ts <= a.to_ts)
		WHERE a.task_id = ?`, taskID).Scan(&cost)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	if _, err := q.ExecContext(ctx, `UPDATE tasks SET cost_usd = ? WHERE id = ?`, cost.Float64, taskID); err != nil {
		return 0, err
	}
	return cost.Float64, nil
}
