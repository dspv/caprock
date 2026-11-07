package daemon

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// drainSteps runs background steps until none is left to do, as the job
// would over many pauses.
func drainSteps(t *testing.T, d *Daemon) {
	t.Helper()
	var ms maintainState
	drainWith(t, d, &ms)
}

// drainWith is drainSteps keeping the job's memory in ms.
func drainWith(t *testing.T, d *Daemon, ms *maintainState) {
	t.Helper()
	ctx := context.Background()
	for i := 0; ; i++ {
		if i > 100000 {
			t.Fatal("the background job never ran out of work")
		}
		did, yielded := d.maintainStep(ctx, ms)
		if yielded {
			t.Fatal("a step yielded with nothing writing")
		}
		if !did {
			break
		}
	}
	d.maintainSay(ms)
}

func withCalm(t *testing.T, dur time.Duration) {
	t.Helper()
	old := calmFor
	calmFor = dur
	t.Cleanup(func() { calmFor = old })
}

// The owner's case: agents never let the daemon be idle for 30 minutes, but
// writes pause for a moment now and then. Over a busy spell with events in
// bursts, the job compresses everything, and the 30-minute rule never once
// holds.
func TestStepsRunWhileAgentsWork(t *testing.T) {
	withFreeSpace(t, 1<<50)
	withCalm(t, 40*time.Millisecond)
	d := zstdDaemon(t, true, 2000)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Bursts: an event every 5 ms for 100 ms, then a pause of 80 ms — the
	// shape of a turn's hooks, scaled down with calmFor.
	var bursts atomic.Int64
	go func() {
		for ctx.Err() == nil {
			for i := 0; i < 20 && ctx.Err() == nil; i++ {
				d.activity.Store(time.Now().UnixMilli())
				time.Sleep(5 * time.Millisecond)
			}
			bursts.Add(1)
			time.Sleep(80 * time.Millisecond)
		}
	}()
	var ms maintainState
	deadline := time.Now().Add(30 * time.Second)
	for blobs(t, d) < 2000 {
		if time.Now().After(deadline) {
			t.Fatalf("%d of 2000 rows compressed in a busy minute; steps %d, yielded %d", blobs(t, d), ms.steps, ms.yielded)
		}
		if d.quiet(time.Now()) {
			t.Fatal("the daemon was idle for idleFor: the test is not busy")
		}
		if !sleepCtx(ctx, min(d.maintainOnce(ctx, &ms), 50*time.Millisecond)) {
			break
		}
	}
	if bursts.Load() < 2 {
		t.Fatalf("only %d bursts: the job did not share the time with writes", bursts.Load())
	}
}

// A write that wants the database during a step interrupts it: the step
// yields, and nothing it read is written.
func TestStepYieldsToAWrite(t *testing.T) {
	withFreeSpace(t, 1<<50)
	d := zstdDaemon(t, true, 600)
	beforeStep = d.writes.want
	t.Cleanup(func() { beforeStep = nil })
	var ms maintainState
	did, yielded := d.maintainStep(context.Background(), &ms)
	if did || !yielded {
		t.Fatalf("did=%v yielded=%v: want a yield", did, yielded)
	}
	if got := blobs(t, d); got != 0 {
		t.Fatalf("%d rows compressed by a step that yielded", got)
	}
	if cur, _ := d.store.PayloadZstdCursor(context.Background()); cur != 0 {
		t.Fatalf("cursor moved to %d", cur)
	}
	beforeStep = nil
	d.activity.Store(time.Now().Add(-time.Hour).UnixMilli())
	d.writes.last.Store(0)
	drainSteps(t, d)
	if got := blobs(t, d); got != 600 {
		t.Fatalf("%d of 600 compressed after the write had gone", got)
	}
}

// The job rests nine times as long as each step took: over a whole pass it
// is busy for at most a tenth of the time.
func TestDutyCycleAtMostATenth(t *testing.T) {
	withFreeSpace(t, 1<<50)
	d := zstdDaemon(t, true, 2000)
	ctx := context.Background()
	var ms maintainState
	var rest time.Duration
	for i := 0; i < 1000 && blobs(t, d) < 2000; i++ {
		rest += d.maintainOnce(ctx, &ms)
	}
	if ms.steps == 0 {
		t.Fatal("no step ran")
	}
	if rest < dutyRest*ms.busy {
		t.Fatalf("rested %s after %s of steps: more than a tenth busy", rest, ms.busy)
	}
	if share := float64(ms.busy) / float64(ms.busy+rest); share > 0.1 {
		t.Fatalf("busy share %.3f", share)
	}
}

// With nothing to do the job sleeps long, not in a spin.
func TestNothingToDoSleeps(t *testing.T) {
	withFreeSpace(t, 1<<50)
	d := zstdDaemon(t, false, 10)
	var ms maintainState
	ctx := context.Background()
	drainSteps(t, d)
	if rest := d.maintainOnce(ctx, &ms); rest != maintainRecheck {
		t.Fatalf("rest %s with nothing to do", rest)
	}
}
