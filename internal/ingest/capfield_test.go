package ingest

import (
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// A tool_result goes through the same cap as the hook copy, and the event
// carries the size the tool really handed back for tool_bytes.
func TestToolResultIsCappedAndKeepsItsOriginalSize(t *testing.T) {
	shot := strings.Repeat("iVBO", 100<<10)
	content := `[{"type":"text","text":"done"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + shot + `"}}]`
	raw := `{"type":"user","sessionId":"s1","uuid":"u2","cwd":"/repo","message":{"role":"user","content":[` +
		`{"type":"tool_result","tool_use_id":"toolu_1","content":` + content + `}]}}`
	line, err := ParseLine([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	var post *event.Event
	for _, ev := range line.Events(time.Now()) {
		if ev.Kind == event.KindToolPost {
			post = &ev
		}
	}
	if post == nil {
		t.Fatal("no tool.post")
	}
	if post.ToolBytes != int64(len(content)) {
		t.Fatalf("ToolBytes = %d, want %d", post.ToolBytes, len(content))
	}
	if strings.Contains(string(post.Payload), "iVBO") || !strings.Contains(string(post.Payload), "[image image/png 300 KB not stored]") {
		t.Fatalf("image not replaced: %.300s", post.Payload)
	}
	if !strings.Contains(string(post.Payload), `"text":"done"`) {
		t.Fatalf("text block lost: %.300s", post.Payload)
	}
}
