package codex

import (
	"context"
	"testing"
	"time"
)

// Kick reads the transcripts now rather than at the next tick: input was just
// typed into a Codex session Caprock holds, and its next line is the prompt.
func TestKickReadsBeforeTheTick(t *testing.T) {
	h := newHarness(t)
	h.in.every = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = h.in.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	// The first pass runs at once; wait for it, then add the transcript.
	deadline := time.Now().Add(10 * time.Second)
	for h.in.Stats().LastPoll == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	h.put()
	h.in.Kick()
	h.in.Kick() // a second before the first ran is the same pass, and never blocks
	for time.Now().Before(deadline) {
		if count(t, h.out, `SELECT COUNT(*) FROM sessions WHERE agent='codex'`) == 1 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("a kick did not read the transcript before the hour's tick")
}
