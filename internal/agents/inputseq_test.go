package agents

import (
	"context"
	"testing"
)

// A session with no pty-host of its own to number input (the in-process
// fallback, or a holder from before protocol v2) is numbered by the daemon:
// a resend is dropped, not typed twice. Its output is counted in the
// daemon's own ring, which the pump fills.
func TestInputSeqIsAppliedOnceWithoutAHolder(t *testing.T) {
	m, _, f := newMgr(t)
	a, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range []struct {
		seq  uint64
		data string
		last uint64
	}{{1, "a", 1}, {1, "a", 1}, {2, "b", 2}, {0, "", 2}, {1, "a", 2}} {
		last, err := m.InputSeq(a.SessionID, "tab", step.seq, []byte(step.data))
		if err != nil || last != step.last {
			t.Fatalf("InputSeq(%d) = %d %v; want %d", step.seq, last, err, step.last)
		}
	}
	f.session.mu.Lock()
	got := string(f.session.written)
	f.session.mu.Unlock()
	if got != "ab" {
		t.Fatalf("typed %q; want \"ab\"", got)
	}
	f.session.out <- []byte("hello")
	if err := waitFor(func() bool { return a.Ring().Total() == 5 }); err != nil {
		t.Fatal("the pump did not count the output in the ring")
	}
	if _, err := m.InputSeq("nobody", "tab", 1, nil); err == nil {
		t.Fatal("a session Caprock did not start must be refused")
	}
}
