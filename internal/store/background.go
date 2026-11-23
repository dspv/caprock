package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Background work: what a Claude Code session's main thread started in the
// background and has not heard the end of (owner, 2026-11-24: the cockpit
// said "Done" and "Subagents · 1 done" while the lead waited on a background
// subagent and a release script; Claude Code's own TUI said "Waiting for 1
// background agent" and "1 background terminal running").
//
// Read from the main thread's own records, in Claude Code's words:
//
//   - A launch is a main-thread PostToolUse: Bash whose tool_response names
//     a backgroundTaskId (run_in_background: true), Agent or Task whose
//     tool_response is isAsync with an agentId, Monitor whose tool_response
//     names a taskId. SendMessage whose tool_response names a resumedAgentId
//     starts that agent again.
//   - An end is a prompt Claude Code wrote into the main thread — a hook's
//     UserPromptSubmit or a transcript user line — starting
//     <task-notification>, naming the task in <task-id> with a <status>
//     (completed, failed, stopped, killed). One with no status is progress (a
//     Monitor's event); an agent's "is waiting on its own background work" is
//     not its end: it stopped with work of its own still running, and the
//     same task id notifies again when that is done. TaskStop (task_id) and
//     KillShell (shell_id) end the task they name.
//   - Everything launched before the process started again (a main-thread
//     SessionStart that did not follow a compaction) went with that process,
//     and an ended session has none. A launch older than BackgroundWorkWindow
//     is not believed either.
//
// A session with no hooks records no launch, so it has none.

// BackgroundWorkWindow is how far back a launch is believed with no end
// heard: a release chain can run an hour, and one that never notified must
// not count forever.
const BackgroundWorkWindow = 12 * time.Hour

// Kinds of BackgroundTask.
const (
	BackgroundAgent   = "agent"
	BackgroundShell   = "shell"
	BackgroundMonitor = "monitor"
)

// maxBackgroundTasks bounds the list: nobody reads forty rows of it.
const maxBackgroundTasks = 24

// BackgroundTask is one piece of work the session's main thread started in
// the background that has not ended.
type BackgroundTask struct {
	// Kind is "agent" (a background subagent), "shell" (a background Bash
	// command) or "monitor" (a Monitor's watch).
	Kind string `json:"kind"`
	// ID is Claude Code's own: the agent's id, or the task id it gave the
	// command or the watch.
	ID string `json:"id"`
	// Description is what the call said it was for (its
	// tool_input.description), at most 120 runes; omitted when it said
	// nothing.
	Description string `json:"description,omitempty"`
	// Command is a shell's or a monitor's command line, its first line, at
	// most 200 runes; omitted for an agent.
	Command string `json:"command,omitempty"`
	// StartedAt is its launch, or the SendMessage that resumed it (unix ms).
	StartedAt int64 `json:"started_at"`
}

// backgroundRow is one record the fold reads, in time order.
type backgroundRow struct {
	ts   int64
	tool string // a call's tool; "" for a notification
	// A call's fields, from its tool_input and tool_response.
	bgTaskID, agentID, taskID, resumed, stopID, desc, command string
	async                                                     bool
	// A notification's prompt.
	prompt string
}

var (
	noteTaskID = regexp.MustCompile(`<task-id>\s*([^<\s]+)\s*</task-id>`)
	noteStatus = regexp.MustCompile(`<status>\s*([^<]*?)\s*</status>`)
	noteSum    = regexp.MustCompile(`(?s)<summary>(.*?)</summary>`)
)

// noteStillWorking is an agent's notification saying it stopped with
// background work of its own still running: not its end.
func noteStillWorking(prompt string) bool {
	sum := ""
	if m := noteSum.FindStringSubmatch(prompt); m != nil {
		sum = m[1]
	}
	return strings.Contains(sum, "waiting on its own background work") ||
		strings.Contains(prompt, "background work of its own still running")
}

// foldBackground reads rows (oldest first) into the tasks still open,
// oldest launch first.
func foldBackground(rows []backgroundRow) []BackgroundTask {
	open := map[string]BackgroundTask{}
	known := map[string]BackgroundTask{}
	start := func(t BackgroundTask) {
		open[t.ID] = t
		known[t.ID] = t
	}
	for _, r := range rows {
		switch r.tool {
		case "":
			ids := noteTaskID.FindAllStringSubmatch(r.prompt, -1)
			st := noteStatus.FindStringSubmatch(r.prompt)
			if len(ids) == 0 || st == nil {
				continue // progress, as a Monitor's event
			}
			switch strings.ToLower(st[1]) {
			case "", "running", "pending":
				continue
			}
			if noteStillWorking(r.prompt) {
				continue
			}
			for _, m := range ids {
				delete(open, m[1])
			}
		case "Bash":
			if r.bgTaskID != "" {
				start(BackgroundTask{Kind: BackgroundShell, ID: r.bgTaskID, Description: clipLine(r.desc, 120), Command: clipLine(r.command, 200), StartedAt: r.ts})
			}
		case "Agent", "Task":
			if r.async && r.agentID != "" {
				start(BackgroundTask{Kind: BackgroundAgent, ID: r.agentID, Description: clipLine(r.desc, 120), StartedAt: r.ts})
			}
		case "Monitor":
			if r.taskID != "" {
				start(BackgroundTask{Kind: BackgroundMonitor, ID: r.taskID, Description: clipLine(r.desc, 120), Command: clipLine(r.command, 200), StartedAt: r.ts})
			}
		case "SendMessage":
			if r.resumed != "" {
				t, ok := known[r.resumed]
				if !ok {
					t = BackgroundTask{Kind: BackgroundAgent, ID: r.resumed}
				}
				t.StartedAt = r.ts
				start(t)
			}
		case "TaskStop", "KillShell":
			if r.stopID != "" {
				delete(open, r.stopID)
			}
		}
	}
	out := make([]BackgroundTask, 0, len(open))
	for _, t := range open {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartedAt != out[j].StartedAt {
			return out[i].StartedAt < out[j].StartedAt
		}
		return out[i].ID < out[j].ID
	})
	if len(out) > maxBackgroundTasks {
		out = out[len(out)-maxBackgroundTasks:]
	}
	return out
}

// clipLine is the first line of s, trimmed, at most n runes.
func clipLine(s string, n int) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

// backgroundCalls are the session's main-thread calls that start or stop
// background work since a moment. The fields come out of one json_extract
// with many paths, so a compressed payload is opened once. Read through
// idx_events_attr_work, which holds each event's kind and tool: only the
// calls of those tools are fetched from the table, never the session's
// other rows (a lead's subagents log thousands an hour).
const backgroundCalls = `
		SELECT e.ts, e.tool, json_extract(` + ZPayloadE + `,
		         '$.tool_response.backgroundTaskId', '$.tool_response.isAsync', '$.tool_response.agentId',
		         '$.tool_response.taskId', '$.tool_response.resumedAgentId', '$.tool_input.task_id',
		         '$.tool_input.shell_id', '$.tool_input.description', '$.tool_input.command')
		  FROM events e INDEXED BY idx_events_attr_work
		 WHERE e.sid = (SELECT sid FROM sessions WHERE session_id = ?) AND e.ts >= ?
		   AND e.kind = 'tool.post' AND e.source = 'hook'
		   AND e.tool IN ('Bash', 'Agent', 'Task', 'Monitor', 'SendMessage', 'TaskStop', 'KillShell')
		   AND COALESCE(e.agent_id, '') = ''
		 ORDER BY e.ts, e.id`

// backgroundNotes are the task notifications Claude Code wrote into the
// session's main thread since a moment, from either plane: one delivered
// while the lead was in a turn reaches the transcript alone.
func backgroundNotes(ctx context.Context, q Querier, sessionID string, since int64) ([]backgroundRow, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT e.ts, json_extract(e.payload, '$.prompt')
		  FROM events e
		 WHERE e.sid = (SELECT sid FROM sessions WHERE session_id = ?) AND e.ts >= ?
		   AND e.kind = 'turn.user' AND COALESCE(e.agent_id, '') = ''
		   AND CASE WHEN json_valid(e.payload) THEN ltrim(json_extract(e.payload, '$.prompt')) END LIKE '<task-notification%'
		 ORDER BY e.ts, e.id`, sessionID, since)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []backgroundRow
	for rows.Next() {
		var r backgroundRow
		var p sql.NullString
		if err := rows.Scan(&r.ts, &p); err != nil {
			return nil, err
		}
		r.prompt = p.String
		out = append(out, r)
	}
	return out, rows.Err()
}

func backgroundCallRows(ctx context.Context, q Querier, sessionID string, since int64) ([]backgroundRow, error) {
	rows, err := q.QueryContext(ctx, backgroundCalls, sessionID, since)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []backgroundRow
	for rows.Next() {
		var r backgroundRow
		var f sql.NullString
		if err := rows.Scan(&r.ts, &r.tool, &f); err != nil {
			return nil, err
		}
		var v []any
		if f.Valid && json.Unmarshal([]byte(f.String), &v) == nil && len(v) == 9 {
			str := func(i int) string { s, _ := v[i].(string); return s }
			r.bgTaskID, r.agentID, r.taskID, r.resumed = str(0), str(2), str(3), str(4)
			// json_extract reads JSON true as the integer 1.
			switch a := v[1].(type) {
			case bool:
				r.async = a
			case float64:
				r.async = a == 1
			}
			r.stopID = str(5)
			if r.stopID == "" {
				r.stopID = str(6)
			}
			r.desc, r.command = str(7), str(8)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// BackgroundWork lists the work a session's main thread started in the
// background and has not heard the end of, oldest launch first (see the top
// of this file). Two reads of the session's own rows since its newest
// process start or BackgroundWorkWindow ago, whichever is later; nil for an
// ended session.
func BackgroundWork(ctx context.Context, q Querier, sessionID string, now int64) ([]BackgroundTask, error) {
	var status sql.NullString
	err := q.QueryRowContext(ctx, `SELECT status FROM sessions WHERE session_id = ?`, sessionID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) || status.String == StatusEnded {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	since := now - BackgroundWorkWindow.Milliseconds()
	restart, err := newestRestart(ctx, q, sessionID, since)
	if err != nil {
		return nil, err
	}
	since = max(since, restart)
	calls, err := backgroundCallRows(ctx, q, sessionID, since)
	if err != nil || len(calls) == 0 {
		return nil, err
	}
	notes, err := backgroundNotes(ctx, q, sessionID, since)
	if err != nil {
		return nil, err
	}
	// Calls first on a tie: a notification answers a launch before it.
	all := make([]backgroundRow, 0, len(calls)+len(notes))
	all = append(append(all, calls...), notes...)
	sort.SliceStable(all, func(i, j int) bool { return all[i].ts < all[j].ts })
	return foldBackground(all), nil
}

// BackgroundAgentIDs is the set of agents among tasks: a background subagent
// Claude Code has not said the end of works, whatever its SubagentStop said
// (it fires when the agent stops to wait on work of its own).
func BackgroundAgentIDs(tasks []BackgroundTask) map[string]bool {
	var out map[string]bool
	for _, t := range tasks {
		if t.Kind == BackgroundAgent {
			if out == nil {
				out = map[string]bool{}
			}
			out[t.ID] = true
		}
	}
	return out
}

// newestRestart is the session's newest main-thread SessionStart since
// `since` that did not follow a compaction (a process start or a resume), or
// 0 with none.
func newestRestart(ctx context.Context, q Querier, sessionID string, since int64) (int64, error) {
	var ts int64
	err := q.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(e.ts), 0) FROM events e
		 WHERE e.sid = (SELECT sid FROM sessions WHERE session_id = ?) AND e.ts >= ?
		   AND +e.kind = 'agent.spawn' AND e.source = 'hook' AND COALESCE(e.agent_id, '') = ''
		   AND COALESCE(json_extract(`+ZPayloadE+`, '$.source'), '') <> 'compact'`, sessionID, since).Scan(&ts)
	return ts, err
}
