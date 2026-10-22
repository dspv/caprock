package agents

import (
	"testing"
	"time"
)

// A session killed or crashed sends no SessionEnd. The PreToolUse calls kept
// for it (each a whole tool input) go when its process exits, not when the
// daemon does.
func TestExitForgetsTheKeptCalls(t *testing.T) {
	m, _, _ := spawnOwned(t)
	pre := signalFrom(t, "fixed-session-id", bashRule)
	pre.Event, pre.ToolUseID = "PreToolUse", "toolu_1"
	m.ObserveHook(pre)
	kept := func() int {
		m.permMu.Lock()
		defer m.permMu.Unlock()
		return len(m.calls["fixed-session-id"])
	}
	if kept() != 1 {
		t.Fatalf("kept %d calls, want 1", kept())
	}
	if err := m.Input("fixed-session-id", []byte("exit\n")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for kept() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the exited session's calls are still kept")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
