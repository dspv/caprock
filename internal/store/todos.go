package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
	"strings"
)

// TodoItem is one entry of the task list an agent keeps for itself: Claude
// Code's TodoWrite and TaskCreate/TaskUpdate, OpenCode's todowrite (stored as
// TodoWrite) and Codex's update_plan.
type TodoItem struct {
	ID         string `json:"id"`
	Text       string `json:"text"`
	Status     string `json:"status"` // pending | in_progress | completed | cancelled
	ActiveForm string `json:"active_form,omitempty"`
}

// TodoList is a session's current task list and when it last changed (unix ms;
// 0 when the session never kept one).
type TodoList struct {
	Items     []TodoItem `json:"items"`
	UpdatedAt int64      `json:"updated_at"`
}

// todoTools are the calls a task list is rebuilt from. TaskList and TaskGet
// only read it, so they are not here.
var todoTools = []string{"TodoWrite", "TaskCreate", "TaskUpdate", "update_plan"}

// SessionTodos rebuilds a session's task list from its own task tool calls.
// A TodoWrite or update_plan call carries the whole list, so the newest one
// is the list. TaskCreate adds one task and TaskUpdate changes one by id;
// Claude Code numbers tasks 1, 2, 3 in the order they were created within the
// session ("Task #3 created successfully"), so the fold numbers them the same
// way. Whichever of the two kinds changed last is the answer. Only the main
// thread counts: a subagent keeps its own list. A call recorded on both the
// hook and the transcript plane is folded once, by tool_use_id.
//
// The query pins idx_events_todo (migration 0066), a partial index of these
// calls alone, so only they are read. Through idx_events_attr_work, which
// holds the session, ts, kind and tool, it walked the session's whole index
// range: 4,820 page reads for the owner's largest session (180k events, no
// task calls) against 10 (F18, docs/resource-usage-audit-2026-10-18.md). The
// tool names are written into the statement, not bound: SQLite uses a
// partial index only when it can see the query's WHERE implies the index's.
func SessionTodos(ctx context.Context, q Querier, sessionID string) (TodoList, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT ts, tool, COALESCE(agent_id, ''), payload
		  FROM events INDEXED BY idx_events_todo
		 WHERE sid = (SELECT sid FROM sessions WHERE session_id = ?) AND kind = 'tool.pre'
		   AND tool IN ('TodoWrite', 'TaskCreate', 'TaskUpdate', 'update_plan')
		 ORDER BY ts, id`, sessionID)
	if err != nil {
		return TodoList{}, err
	}
	defer rows.Close()

	var f todoFold
	for rows.Next() {
		var (
			ts            int64
			tool, agentID string
			payload       sql.RawBytes
		)
		if err := rows.Scan(&ts, &tool, &agentID, &payload); err != nil {
			return TodoList{}, err
		}
		if agentID != "" {
			continue
		}
		f.add(ts, tool, payload)
	}
	if err := rows.Err(); err != nil {
		return TodoList{}, err
	}
	return f.result(), nil
}

// todoFold folds task tool calls, oldest first, into the current list.
type todoFold struct {
	seen map[string]bool

	snapshot   []TodoItem // the newest TodoWrite / update_plan
	snapshotAt int64

	tasks   []TodoItem // TaskCreate / TaskUpdate, in creation order
	tasksAt int64
	nextID  int
}

type todoCall struct {
	ToolUseID string          `json:"tool_use_id"`
	Input     json.RawMessage `json:"tool_input"`
}

func (f *todoFold) add(ts int64, tool string, payload []byte) {
	var c todoCall
	if json.Unmarshal(payload, &c) != nil || len(c.Input) == 0 {
		return
	}
	if c.ToolUseID != "" {
		if f.seen[c.ToolUseID] {
			return
		}
		if f.seen == nil {
			f.seen = map[string]bool{}
		}
		f.seen[c.ToolUseID] = true
	}
	switch tool {
	case "TodoWrite":
		var in struct {
			Todos []struct {
				ID         any    `json:"id"`
				Content    string `json:"content"`
				Status     string `json:"status"`
				ActiveForm string `json:"activeForm"`
			} `json:"todos"`
		}
		if json.Unmarshal(c.Input, &in) != nil || in.Todos == nil {
			return
		}
		items := make([]TodoItem, 0, len(in.Todos))
		for i, t := range in.Todos {
			id := strconv.Itoa(i + 1)
			if s, ok := t.ID.(string); ok && s != "" {
				id = s
			}
			items = append(items, TodoItem{ID: id, Text: strings.TrimSpace(t.Content), Status: todoStatus(t.Status), ActiveForm: strings.TrimSpace(t.ActiveForm)})
		}
		f.snapshot, f.snapshotAt = items, ts
	case "update_plan":
		var in struct {
			Plan []struct {
				Step   string `json:"step"`
				Status string `json:"status"`
			} `json:"plan"`
		}
		if json.Unmarshal(c.Input, &in) != nil || in.Plan == nil {
			return
		}
		items := make([]TodoItem, 0, len(in.Plan))
		for i, p := range in.Plan {
			items = append(items, TodoItem{ID: strconv.Itoa(i + 1), Text: strings.TrimSpace(p.Step), Status: todoStatus(p.Status)})
		}
		f.snapshot, f.snapshotAt = items, ts
	case "TaskCreate":
		var in struct {
			Subject    string `json:"subject"`
			ActiveForm string `json:"activeForm"`
			Status     string `json:"status"`
		}
		if json.Unmarshal(c.Input, &in) != nil {
			return
		}
		f.nextID++
		f.tasks = append(f.tasks, TodoItem{ID: strconv.Itoa(f.nextID), Text: strings.TrimSpace(in.Subject), Status: todoStatus(in.Status), ActiveForm: strings.TrimSpace(in.ActiveForm)})
		f.tasksAt = ts
	case "TaskUpdate":
		var in struct {
			TaskID     any    `json:"taskId"`
			Subject    string `json:"subject"`
			ActiveForm string `json:"activeForm"`
			Status     string `json:"status"`
		}
		if json.Unmarshal(c.Input, &in) != nil {
			return
		}
		id := todoID(in.TaskID)
		for i := range f.tasks {
			if f.tasks[i].ID != id {
				continue
			}
			if in.Status == "deleted" {
				f.tasks = append(f.tasks[:i], f.tasks[i+1:]...)
			} else {
				if in.Status != "" {
					f.tasks[i].Status = todoStatus(in.Status)
				}
				if s := strings.TrimSpace(in.Subject); s != "" {
					f.tasks[i].Text = s
				}
				if s := strings.TrimSpace(in.ActiveForm); s != "" {
					f.tasks[i].ActiveForm = s
				}
			}
			f.tasksAt = ts
			break
		}
	}
}

func (f *todoFold) result() TodoList {
	out := TodoList{Items: []TodoItem{}}
	switch {
	case f.tasksAt == 0 && f.snapshotAt == 0:
	case f.tasksAt >= f.snapshotAt:
		out.Items, out.UpdatedAt = append(out.Items, f.tasks...), f.tasksAt
	default:
		out.Items, out.UpdatedAt = f.snapshot, f.snapshotAt
	}
	return out
}

// todoID reads a task id that a model may write as "3" or 3.
func todoID(v any) string {
	switch x := v.(type) {
	case string:
		return strings.TrimPrefix(strings.TrimSpace(x), "#")
	case float64:
		return strconv.FormatInt(int64(x), 10)
	}
	return ""
}

// todoStatus maps the agents' spellings onto four states; anything unknown
// (OpenCode's "planned", an empty status) is still to do.
func todoStatus(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "completed", "done", "complete":
		return "completed"
	case "in_progress", "in-progress", "active", "running":
		return "in_progress"
	case "cancelled", "canceled":
		return "cancelled"
	}
	return "pending"
}
