package eta

import (
	"testing"
	"time"
)

func secs(ns ...int) []time.Duration {
	out := make([]time.Duration, len(ns))
	for i, n := range ns {
		out[i] = time.Duration(n) * time.Second
	}
	return out
}

func TestTooFewSamples(t *testing.T) {
	s, ok := New(secs(10, 20, 30, 40))
	if ok || s.N != 4 {
		t.Fatalf("4 turns gave ok=%v n=%d, want no estimate and the count", ok, s.N)
	}
	if _, ok := New(secs(10, 20, 30, 40, -5)); ok {
		t.Fatal("a negative duration counted as a sample")
	}
	if _, ok := New(secs(10, 20, 30, 40, 50)); !ok {
		t.Fatal("five turns gave no estimate")
	}
}

func TestQuantiles(t *testing.T) {
	s, _ := New(secs(50, 10, 40, 20, 30)) // unsorted on purpose
	if s.Median != 30*time.Second || s.P25 != 20*time.Second || s.P75 != 40*time.Second {
		t.Fatalf("got p25 %v median %v p75 %v", s.P25, s.Median, s.P75)
	}
	// Interpolated between ranks: six values, the median halfway between 30 and 40.
	s, _ = New(secs(10, 20, 30, 40, 50, 60))
	if s.Median != 35*time.Second {
		t.Fatalf("median of six = %v, want 35s", s.Median)
	}
	if Quantile(nil, 0.5) != 0 {
		t.Fatal("quantile of nothing is not 0")
	}
}

func TestRemainingBeforeTheMedian(t *testing.T) {
	s, _ := New(secs(60, 120, 180, 240, 300)) // p25 120, median 180, p75 240
	r, ok := s.Remaining(150 * time.Second)
	if !ok {
		t.Fatal("no estimate")
	}
	want := Range{Lo: 0, Mid: 30 * time.Second, Hi: 90 * time.Second}
	if r != want {
		t.Fatalf("remaining at 150s = %+v, want %+v (p25 floored at 0)", r, want)
	}
	r, _ = s.Remaining(-time.Second)
	if r.Mid != 180*time.Second {
		t.Fatalf("a negative elapsed = %v, want the whole median", r.Mid)
	}
}

func TestRemainingPastTheMedianIsConditional(t *testing.T) {
	// Past the median, "median − elapsed" would be 0; what the turns that ran
	// this long still took is the answer instead.
	s, _ := New(secs(10, 20, 30, 40, 50, 400, 500, 600, 700, 800))
	r, ok := s.Remaining(300 * time.Second)
	if !ok {
		t.Fatal("no estimate with five longer turns")
	}
	// Left: 100, 200, 300, 400, 500.
	if r.Mid != 300*time.Second || r.Lo != 200*time.Second || r.Hi != 400*time.Second {
		t.Fatalf("remaining past the median = %+v", r)
	}
	// Longer than all but four: no estimate.
	if _, ok := s.Remaining(450 * time.Second); ok {
		t.Fatal("estimated a turn that outlasted all but four seen")
	}
}

func TestQueuedPositions(t *testing.T) {
	s, _ := New(secs(60, 120, 180, 240, 300)) // turn: 120 / 180 / 240
	rem := Range{Lo: 0, Mid: 30 * time.Second, Hi: 90 * time.Second}
	// First in line: starts when this turn ends, done one turn later.
	start, done := s.Queued(rem, 0)
	if start != rem {
		t.Fatalf("first starts at %+v, want the current turn's remaining", start)
	}
	if done.Mid != 210*time.Second || done.Lo != 120*time.Second || done.Hi != 330*time.Second {
		t.Fatalf("first done = %+v", done)
	}
	// Third in line: two turns ahead of it after this one.
	start, done = s.Queued(rem, 2)
	if start.Mid != 390*time.Second || start.Lo != 240*time.Second || start.Hi != 570*time.Second {
		t.Fatalf("third start = %+v", start)
	}
	if done.Mid != 570*time.Second {
		t.Fatalf("third done = %v", done.Mid)
	}
	// At the prompt: nothing to wait for but the turns ahead.
	start, _ = s.Queued(Range{}, 0)
	if start != (Range{}) {
		t.Fatalf("idle session's first message starts at %+v, want now", start)
	}
}
