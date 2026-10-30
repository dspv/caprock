package store

import (
	"context"
	"testing"
)

// A session's effort is the newest one a hook named: /effort changes it
// mid-session, and an event that names none leaves it as it was.
func TestUpsertSessionKeepsTheNewestEffort(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	step := func(effort, want string) {
		t.Helper()
		if err := UpsertSession(ctx, s.DB(), "s", SessionPatch{Cwd: "/w", FromHook: true, Effort: effort}); err != nil {
			t.Fatal(err)
		}
		got, err := GetSession(ctx, s.DB(), "s")
		if err != nil || got.Effort != want {
			t.Fatalf("after %q: effort %q, %v; want %q", effort, got.Effort, err, want)
		}
	}
	step("", "")
	step("medium", "medium")
	step("", "medium")
	step("xhigh", "xhigh")
}
