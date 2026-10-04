package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/license"
	"github.com/dspv/caprock/internal/store"
)

// The breakdown is free; what came back and how often it failed is Premium,
// and the server — not the page — leaves it out without a licence. One hint
// travels in full either way, so the locked view shows what it would say.
func TestToolDrillGatesThePremiumHalfOnTheServer(t *testing.T) {
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

	var raw map[string]any
	if code := e.get(t, "/v1/tools/drill?tool=Bash&range=all", &raw); code != 200 {
		t.Fatalf("status %d", code)
	}
	if raw["locked"] != true || raw["calls"].(float64) != 70 {
		t.Fatalf("locked drill %v", raw)
	}
	for _, k := range []string{"failures", "bytes", "results", "hints", "trend_from_ms"} {
		if _, ok := raw[k]; ok {
			t.Errorf("an unlicensed drill carried %q", k)
		}
	}
	row := raw["rows"].([]any)[0].(map[string]any)
	if row["key"] != "make check" || row["calls"].(float64) != 60 {
		t.Fatalf("row %v", row)
	}
	for _, k := range []string{"failures", "bytes", "trend"} {
		if _, ok := row[k]; ok {
			t.Errorf("an unlicensed row carried %q", k)
		}
	}
	if teaser, ok := raw["teaser"].(map[string]any); !ok || !strings.Contains(teaser["text"].(string), "make check") {
		t.Fatalf("teaser %v", raw["teaser"])
	}

	cur := e.settings.Get()
	cur.LicenseKey = license.Issue(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), license.RandomSuffix)
	if err := e.settings.Set(cur); err != nil {
		t.Fatal(err)
	}
	var full ToolDrillResponse
	if code := e.get(t, "/v1/tools/drill?tool=Bash&range=all", &full); code != 200 {
		t.Fatalf("status %d", code)
	}
	if full.Locked || full.Failures != 20 || full.Rows[0].Bytes < 6000 || len(full.Rows[0].Trend) == 0 || len(full.Hints) == 0 {
		t.Fatalf("licensed drill %+v", full)
	}

	if code := e.get(t, "/v1/tools/drill?range=all", nil); code != 400 {
		t.Fatalf("no tool answered %d", code)
	}
	if code := e.get(t, "/v1/tools/drill?tool=Bash&agent=nobody", nil); code != 400 {
		t.Fatalf("unknown agent answered %d", code)
	}
}
