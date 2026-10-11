package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// The inspector's Tasks block: the agent's own task list, rebuilt from its
// TaskCreate/TaskUpdate calls, with the field names the UI reads.
func TestSessionTodosEndpoint(t *testing.T) {
	e := newEnv(t)
	put := func(i int, tool, input string) {
		p, _ := json.Marshal(map[string]any{"tool_name": tool, "tool_use_id": "toolu_" + strconv.Itoa(i), "tool_input": json.RawMessage(input)})
		ev := event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindToolPre, Tool: tool,
			Ts: e.now.Add(time.Duration(i) * time.Second), Payload: p, Key: "pre:" + strconv.Itoa(i)}
		if _, err := store.InsertEvent(context.Background(), e.st.DB(), &ev); err != nil {
			t.Fatal(err)
		}
	}
	put(0, "TaskCreate", `{"subject":"Write the store query","activeForm":"Writing the store query"}`)
	put(1, "TaskCreate", `{"subject":"Draw the block","activeForm":"Drawing the block"}`)
	put(2, "TaskUpdate", `{"taskId":"1","status":"completed"}`)
	put(3, "TaskUpdate", `{"taskId":"2","status":"in_progress"}`)

	var raw map[string]json.RawMessage
	if code := e.get(t, "/v1/sessions/s1/todos", &raw); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	var items []map[string]string
	if err := json.Unmarshal(raw["items"], &items); err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("items = %v", items)
	}
	if items[0]["id"] != "1" || items[0]["status"] != "completed" || items[0]["text"] != "Write the store query" {
		t.Errorf("first = %v", items[0])
	}
	if items[1]["status"] != "in_progress" || items[1]["active_form"] != "Drawing the block" {
		t.Errorf("second = %v", items[1])
	}
	var at int64
	if err := json.Unmarshal(raw["updated_at"], &at); err != nil || at != e.now.Add(3*time.Second).UnixMilli() {
		t.Errorf("updated_at = %s", raw["updated_at"])
	}

	// No list: an empty array, not null, so the UI can iterate it.
	var none map[string]json.RawMessage
	if code := e.get(t, "/v1/sessions/nobody/todos", &none); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if string(none["items"]) != "[]" || string(none["updated_at"]) != "0" {
		t.Errorf("empty = items %s, updated_at %s", none["items"], none["updated_at"])
	}
}
