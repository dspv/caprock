package bus

import (
	"testing"
	"time"
)

func publishN(b *Bus, n int) {
	for i := 0; i < n; i++ {
		b.Publish(Frame{Type: FrameEvent, Data: i})
	}
}

func TestPublishNumbersFramesInOrder(t *testing.T) {
	b := New()
	s := b.Subscribe(8)
	publishN(b, 3)
	first := <-s.C
	for i := 1; i < 3; i++ {
		if f := <-s.C; f.Seq != first.Seq+uint64(i) {
			t.Fatalf("frame %d: seq %d after %d", i, f.Seq, first.Seq)
		}
	}
}

func TestResumeInsideRingReturnsExactlyTheMissedFrames(t *testing.T) {
	b := New()
	publishN(b, 5)
	if _, _, ok := b.Since(0); ok { // nothing held below the start
		t.Fatal("since 0 replayed")
	}
	_, last, _ := b.Since(b.seq)
	since := last - 2
	s, missed, seq, ok := b.Resume(4, &since)
	defer s.Unsubscribe()
	if !ok || seq != last || len(missed) != 2 || missed[0].Seq != since+1 || missed[1].Seq != since+2 || missed[1].Data != 4 {
		t.Fatalf("resume: ok=%v seq=%d last=%d missed=%+v", ok, seq, last, missed)
	}
	b.Publish(Frame{Type: FrameEvent, Data: "next"})
	if f := <-s.C; f.Seq != last+1 {
		t.Fatalf("live after replay: %+v", f)
	}
	// A client already at the newest frame misses nothing.
	if missed, _, ok := b.Since(last + 1); !ok || len(missed) != 0 {
		t.Fatalf("up to date: %v %v", ok, missed)
	}
}

func TestResumeOutsideRingIsRefused(t *testing.T) {
	b := New()
	start := b.seq
	publishN(b, ReplayFrames+1)
	if len(b.ring) != ReplayFrames {
		t.Fatalf("ring holds %d", len(b.ring))
	}
	if _, _, ok := b.Since(start); ok {
		t.Fatal("a compacted frame was replayed")
	}
	if missed, _, ok := b.Since(start + 1); !ok || len(missed) != ReplayFrames {
		t.Fatalf("oldest held: %v %d", ok, len(missed))
	}
	// A seq from the future (another daemon) is not held either.
	if _, _, ok := b.Since(b.seq + 1); ok {
		t.Fatal("future seq accepted")
	}
}

func TestReplayRingForgetsFramesAfterTenMinutes(t *testing.T) {
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	b := newAt(func() time.Time { return now })
	start := b.seq
	publishN(b, 2)
	now = now.Add(ReplayAge - time.Second)
	b.Publish(Frame{Type: FrameEvent, Data: "late"})
	if missed, _, ok := b.Since(start); !ok || len(missed) != 3 {
		t.Fatalf("inside ten minutes: %v %d", ok, len(missed))
	}
	now = now.Add(2 * time.Second)
	if _, _, ok := b.Since(start); ok {
		t.Fatal("a frame older than ten minutes was replayed")
	}
	if missed, _, ok := b.Since(start + 2); !ok || len(missed) != 1 || missed[0].Data != "late" {
		t.Fatalf("the young frame: %v %+v", ok, missed)
	}
}

func TestANewBusNeverReusesAnOlderOnesSeq(t *testing.T) {
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	old := newAt(func() time.Time { return now })
	publishN(old, 10)
	_, last, _ := old.Since(old.seq)
	// The next daemon starts a moment later; a client resuming with the old
	// daemon's seq is told to refetch, never served the new daemon's frames.
	now = now.Add(time.Millisecond)
	b := newAt(func() time.Time { return now })
	if b.seq <= last {
		t.Fatalf("new bus starts at %d, not past the old one's %d", b.seq, last)
	}
	if _, _, ok := b.Since(last); ok {
		t.Fatal("old seq accepted")
	}
	if b.seq >= 1<<53 {
		t.Fatalf("seq %d is not exact in JavaScript", b.seq)
	}
}
