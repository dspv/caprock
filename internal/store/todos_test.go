package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

type todoFixture struct {
	*weekFixture
	at  time.Time
	sec int
}

func newTodoFixture(t *testing.T) *todoFixture {
	return &todoFixture{weekFixture: &weekFixture{t: t, s: openTest(t), loc: time.UTC}, at: time.Date(2026, 10, 11, 9, 0, 0, 0, time.UTC)}
}

// call records one tool.pre with the payload shape the transcript plane
// stores (tool_name, tool_input, tool_use_id).
func (f *todoFixture) call(sess, agent, tool, useID, input string) {
	f.sec++
	p, _ := json.Marshal(map[string]any{"tool_name": tool, "tool_use_id": useID, "tool_input": json.RawMessage(input)})
	f.put(event.Event{SessionID: sess, AgentID: agent, Source: event.SourceTranscript, Kind: event.KindToolPre, Tool: tool,
		Ts: f.at.Add(time.Duration(f.sec) * time.Second), Payload: p})
}

func (f *todoFixture) todos(sess string) TodoList {
	f.t.Helper()
	got, err := SessionTodos(context.Background(), f.weekFixture.s.DB(), sess)
	if err != nil {
		f.t.Fatal(err)
	}
	return got
}

// The newest TodoWrite is the list; a subagent's TodoWrite and another
// session's are not it.
func TestSessionTodosTodoWriteSnapshot(t *testing.T) {
	f := newTodoFixture(t)
	f.call("s", "", "TodoWrite", "u1", `{"todos":[{"content":"Read the code","status":"pending","activeForm":"Reading the code"}]}`)
	f.call("s", "", "TodoWrite", "u2", `{"todos":[{"content":"Read the code","status":"completed","activeForm":"Reading the code"},{"content":"Write the test","status":"in_progress","activeForm":"Writing the test"},{"content":"Ship","status":"pending","activeForm":"Shipping"}]}`)
	f.call("s", "agent-1", "TodoWrite", "u3", `{"todos":[{"content":"subagent plan","status":"pending"}]}`)
	f.call("other", "", "TodoWrite", "u4", `{"todos":[{"content":"elsewhere","status":"pending"}]}`)

	got := f.todos("s")
	want := []TodoItem{
		{ID: "1", Text: "Read the code", Status: "completed", ActiveForm: "Reading the code"},
		{ID: "2", Text: "Write the test", Status: "in_progress", ActiveForm: "Writing the test"},
		{ID: "3", Text: "Ship", Status: "pending", ActiveForm: "Shipping"},
	}
	if len(got.Items) != len(want) {
		t.Fatalf("items = %+v", got.Items)
	}
	for i := range want {
		if got.Items[i] != want[i] {
			t.Errorf("item %d = %+v, want %+v", i, got.Items[i], want[i])
		}
	}
	if wantAt := f.at.Add(2 * time.Second).UnixMilli(); got.UpdatedAt != wantAt {
		t.Errorf("updated_at = %d, want %d", got.UpdatedAt, wantAt)
	}
}

// TaskCreate numbers tasks as Claude Code does; TaskUpdate changes one by
// id, "deleted" removes it, an unknown id and a repeated tool_use_id change
// nothing.
func TestSessionTodosTaskFold(t *testing.T) {
	f := newTodoFixture(t)
	f.call("s", "", "TaskCreate", "c1", `{"subject":"Localize progress","description":"long text","activeForm":"Localizing progress"}`)
	f.call("s", "", "TaskCreate", "c2", `{"subject":"Explicit done state","activeForm":"Adding done state"}`)
	f.call("s", "", "TaskCreate", "c2", `{"subject":"Explicit done state","activeForm":"Adding done state"}`) // hook copy of the same call
	f.call("s", "", "TaskCreate", "c3", `{"subject":"Throwaway"}`)
	f.call("s", "", "TaskUpdate", "p1", `{"taskId":"1","status":"in_progress"}`)
	f.call("s", "", "TaskUpdate", "p2", `{"taskId":"1","status":"completed"}`)
	f.call("s", "", "TaskUpdate", "p3", `{"taskId":2,"status":"in_progress","subject":"Explicit done state on the page"}`)
	f.call("s", "", "TaskUpdate", "p4", `{"taskId":"3","status":"deleted"}`)
	f.call("s", "", "TaskUpdate", "p5", `{"taskId":"99","status":"completed"}`)

	got := f.todos("s")
	want := []TodoItem{
		{ID: "1", Text: "Localize progress", Status: "completed", ActiveForm: "Localizing progress"},
		{ID: "2", Text: "Explicit done state on the page", Status: "in_progress", ActiveForm: "Adding done state"},
	}
	if len(got.Items) != len(want) {
		t.Fatalf("items = %+v", got.Items)
	}
	for i := range want {
		if got.Items[i] != want[i] {
			t.Errorf("item %d = %+v, want %+v", i, got.Items[i], want[i])
		}
	}
	if wantAt := f.at.Add(8 * time.Second).UnixMilli(); got.UpdatedAt != wantAt {
		t.Errorf("updated_at = %d, want %d (the delete, not the unknown id)", got.UpdatedAt, wantAt)
	}
}

// Codex's update_plan and OpenCode's statuses read as the same four states,
// and the kind that changed last wins.
func TestSessionTodosPlanAndNewestKindWins(t *testing.T) {
	f := newTodoFixture(t)
	f.call("s", "", "TaskCreate", "c1", `{"subject":"old task"}`)
	f.call("s", "", "update_plan", "p1", `{"plan":[{"step":"Collect","status":"completed"},{"step":"Build","status":"in_progress"},{"step":"Doc","status":"planned"},{"step":"Drop","status":"cancelled"}]}`)
	got := f.todos("s")
	if len(got.Items) != 4 || got.Items[0].Status != "completed" || got.Items[1].Status != "in_progress" ||
		got.Items[2].Status != "pending" || got.Items[3].Status != "cancelled" || got.Items[1].Text != "Build" {
		t.Fatalf("plan = %+v", got.Items)
	}
	f.call("s", "", "TaskUpdate", "u1", `{"taskId":"1","status":"in_progress"}`)
	if got := f.todos("s"); len(got.Items) != 1 || got.Items[0].Text != "old task" {
		t.Fatalf("after a task update the task list wins: %+v", got.Items)
	}
}

// A session that never kept a list answers an empty list, not null.
func TestSessionTodosNone(t *testing.T) {
	f := newTodoFixture(t)
	f.call("s", "", "Bash", "b1", `{"command":"ls"}`)
	got := f.todos("s")
	if got.Items == nil || len(got.Items) != 0 || got.UpdatedAt != 0 {
		t.Fatalf("got %+v", got)
	}
}
