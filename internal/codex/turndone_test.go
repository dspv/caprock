package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// OnTurnDone hears each request Codex completed once, in the incremental read
// and in the full one alike: not while a request runs, not again for a file
// that did not move, and not for a request that was aborted.
func TestOnTurnDoneHearsEachCompletedRequestOnce(t *testing.T) {
	t.Parallel()
	for _, replay := range []bool{false, true} {
		h := newHarness(t)
		h.in.replay = replay
		var told []string
		h.in.OnTurnDone = func(id string, at time.Time) {
			if at.IsZero() {
				t.Errorf("told a turn end with no time")
			}
			told = append(told, id)
		}
		p := filepath.Join(h.dir, "2026", "10", "18", "rollout-2026-10-18T10-00-00-01f3f3f3-0000-7000-8000-000000000001.jsonl")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		appendFile(t, p, []byte(growthMeta+"\n"))
		for i := 0; i < 7; i++ { // the first request, all but its task_complete
			appendFile(t, p, growthRecord(i))
		}
		h.poll()
		if len(told) != 0 {
			t.Fatalf("replay=%v: told %v while the request ran", replay, told)
		}
		appendFile(t, p, growthRecord(7)) // task_complete
		h.poll()
		if len(told) != 1 || told[0] != "01f3f3f3-0000-7000-8000-000000000001" {
			t.Fatalf("replay=%v: told %v after task_complete, want the session once", replay, told)
		}
		h.poll()
		appendFile(t, p, growthRecord(8)) // the next request starts
		h.poll()
		if len(told) != 1 {
			t.Fatalf("replay=%v: told %v again without a new task_complete", replay, told)
		}
		aborted, _ := json.Marshal(map[string]any{"timestamp": "2026-10-18T10:00:01Z", "type": "event_msg",
			"payload": map[string]any{"type": "turn_aborted", "turn_id": "turn-1"}})
		appendFile(t, p, append(aborted, '\n'))
		h.poll()
		if len(told) != 1 {
			t.Fatalf("replay=%v: an aborted request was told as done: %v", replay, told)
		}
		for i := 16; i < 24; i++ { // a whole request that completes
			appendFile(t, p, growthRecord(i))
		}
		h.poll()
		if len(told) != 2 {
			t.Fatalf("replay=%v: told %v, want a second turn end", replay, told)
		}
	}
}
