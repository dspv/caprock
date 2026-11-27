package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// The whole drill is free: what came back and how often it failed, with the
// hints, and no licence.
func TestToolDrillIsWhole(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	for i := 0; i < 70; i++ {
		id := "c" + time.Duration(i).String()
		cmd := "make check"
		if i >= 60 {
			cmd = "ls"
		}
		pre, _ := json.Marshal(map[string]any{"cwd": "/r", "tool_input": map[string]any{"command": cmd}})
		post, _ := json.Marshal(map[string]any{"tool_response": strings.Repeat("x", 100), "is_error": i < 20})
		at := e.now.Add(-time.Duration(i) * time.Minute)
		for _, ev := range []event.Event{
			{SessionID: "s", Source: event.SourceTranscript, Kind: event.KindToolPre, Tool: "Bash", Ts: at, Key: "pre:" + id, Payload: pre},
			{SessionID: "s", Source: event.SourceTranscript, Kind: event.KindToolPost, Ts: at, Key: "post:" + id, Payload: post},
		} {
			if _, err := store.InsertEvent(ctx, e.st.DB(), &ev); err != nil {
				t.Fatal(err)
			}
		}
	}

	// No licence: the whole drill, figures and hints (2026-11-27, ADR-022 amended).
	var full ToolDrillResponse
	if code := e.get(t, "/v1/tools/drill?tool=Bash&range=all", &full); code != 200 {
		t.Fatalf("status %d", code)
	}
	if full.Failures != 20 || full.Rows[0].Bytes < 6000 || len(full.Rows[0].Trend) == 0 || len(full.Hints) == 0 {
		t.Fatalf("drill %+v", full)
	}

	if code := e.get(t, "/v1/tools/drill?range=all", nil); code != 400 {
		t.Fatalf("no tool answered %d", code)
	}
	if code := e.get(t, "/v1/tools/drill?tool=Bash&agent=nobody", nil); code != 400 {
		t.Fatalf("unknown agent answered %d", code)
	}
}
