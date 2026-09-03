package store

import (
	"context"
	"testing"
)

// /clear keeps the process and starts a new session id inside it. The session
// it replaced therefore shares a *live* pid with its replacement, and the
// staleness sweep judges a session by whether its process is alive — so
// nothing could ever retire the old row. One editor showed up on the dashboard
// as two working sessions, the stale one frozen at the moment it was cleared
// with its whole cost and a 95%-full context still presented as current.
func TestClearRetiresTheSessionItReplaced(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	for _, id := range []string{"old", "new"} {
		if err := UpsertSession(ctx, s.db, id, SessionPatch{PID: 4242, LastEventAt: 1}); err != nil {
			t.Fatal(err)
		}
	}
	n, err := EndSupersededSiblings(ctx, s.db, 4242, "new")
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("retired %d sessions, want 1", n)
	}
	old, err := GetSession(ctx, s.db, "old")
	if err != nil {
		t.Fatal(err)
	}
	if old.Status != StatusEnded {
		t.Errorf("the replaced session is %q, want %q", old.Status, StatusEnded)
	}
	fresh, err := GetSession(ctx, s.db, "new")
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Status == StatusEnded {
		t.Error("the replacement was retired by its own /clear")
	}
}

// pid 0 means "we never learned it" — written by an older shim, or read from a
// transcript with no process behind it. Matching on it would sweep together
// every session that shares that ignorance, which is most of the history on a
// machine that has been upgraded.
func TestAnUnknownPIDSupersedesNothing(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	for _, id := range []string{"a", "b"} {
		if err := UpsertSession(ctx, s.db, id, SessionPatch{LastEventAt: 1}); err != nil {
			t.Fatal(err)
		}
	}
	n, err := EndSupersededSiblings(ctx, s.db, 0, "b")
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("retired %d sessions on an unknown pid, want 0", n)
	}
	a, err := GetSession(ctx, s.db, "a")
	if err != nil {
		t.Fatal(err)
	}
	if a.Status == StatusEnded {
		t.Error("a session was retired because its pid was unknown")
	}
}

// A session in another process is not superseded by this one's /clear.
func TestAnotherProcessIsUntouched(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	if err := UpsertSession(ctx, s.db, "mine", SessionPatch{PID: 10, LastEventAt: 1}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSession(ctx, s.db, "theirs", SessionPatch{PID: 11, LastEventAt: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := EndSupersededSiblings(ctx, s.db, 10, "mine"); err != nil {
		t.Fatal(err)
	}
	other, err := GetSession(ctx, s.db, "theirs")
	if err != nil {
		t.Fatal(err)
	}
	if other.Status == StatusEnded {
		t.Error("a session in another process was retired")
	}
}
