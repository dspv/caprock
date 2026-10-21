package store

import (
	"context"
	"testing"
)

// One process ran spawn, then c1 and c2 after two /clears; a fork of c1 ran
// in a process of its own. The chain follows the pid, never the fork.
func TestClearChainFollowsTheProcessNotTheFork(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db := s.DB()
	for _, r := range []struct {
		id, parent string
		pid        int
		started    int64
	}{
		{"spawn", "", 100, 1},
		{"c1", "spawn", 100, 2},
		{"fork", "c1", 200, 4},
		{"c2", "c1", 100, 3},
	} {
		if err := UpsertSession(ctx, db, r.id, SessionPatch{Cwd: "/w", StartedAt: r.started, LastEventAt: r.started, PID: r.pid, ParentSession: r.parent}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := ClearSuccessor(ctx, db, "spawn")
	if err != nil || got != "c2" {
		t.Errorf("ClearSuccessor(spawn) = %q, %v; want c2 — the fork is newer but another process", got, err)
	}
	if got, _ := ClearSuccessor(ctx, db, "c2"); got != "" {
		t.Errorf("ClearSuccessor(c2) = %q, want none", got)
	}
	anc, err := ClearAncestors(ctx, db, "c2")
	if err != nil || len(anc) != 2 || anc[0] != "c1" || anc[1] != "spawn" {
		t.Errorf("ClearAncestors(c2) = %v, %v; want [c1 spawn]", anc, err)
	}
	if anc, _ := ClearAncestors(ctx, db, "fork"); len(anc) != 0 {
		t.Errorf("ClearAncestors(fork) = %v, want none: a fork is not a /clear", anc)
	}
}

// The session a /clear started in a process Caprock started is Caprock's;
// one started in a process the user started is not.
func TestInheritOwnedOnlyFromAnOwnedSession(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db := s.DB()
	for _, id := range []string{"spawn", "next", "theirs", "theirs-next"} {
		if err := UpsertSession(ctx, db, id, SessionPatch{Cwd: "/w", StartedAt: 1, LastEventAt: 1, PID: 7}); err != nil {
			t.Fatal(err)
		}
	}
	if err := MarkOwned(ctx, db, "spawn", "wt-1", "claude --session-id spawn", 7); err != nil {
		t.Fatal(err)
	}
	if err := InheritOwned(ctx, db, "next", "spawn"); err != nil {
		t.Fatal(err)
	}
	if err := InheritOwned(ctx, db, "theirs-next", "theirs"); err != nil {
		t.Fatal(err)
	}
	n, _ := GetSession(ctx, db, "next")
	if !n.Owned || n.Worktree != "wt-1" || n.SpawnCommand != "claude --session-id spawn" {
		t.Errorf("next = owned %v, worktree %q, command %q; want the spawn's", n.Owned, n.Worktree, n.SpawnCommand)
	}
	if o, _ := GetSession(ctx, db, "theirs-next"); o.Owned {
		t.Error("a session in a process the user started became Caprock's")
	}
}
