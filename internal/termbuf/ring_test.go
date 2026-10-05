package termbuf

import (
	"errors"
	"testing"
	"time"
)

func TestRingCountsEveryByteAndServesSince(t *testing.T) {
	r := NewRing(8)
	r.Write([]byte("abcdef"))
	r.Write([]byte("ghij")) // drops "ab"
	if r.Total() != 10 || r.Start() != 2 {
		t.Fatalf("total %d start %d; want 10 and 2", r.Total(), r.Start())
	}
	if b, ok := r.Since(5); !ok || string(b) != "fghij" {
		t.Fatalf("Since(5) = %q %v", b, ok)
	}
	if b, ok := r.Since(10); !ok || len(b) != 0 {
		t.Fatalf("Since(total) = %q %v; want empty and ok", b, ok)
	}
	if _, ok := r.Since(1); ok {
		t.Fatal("Since before the ring's start must fail: those bytes are gone")
	}
	if _, ok := r.Since(11); ok {
		t.Fatal("Since past the end must fail: that offset is some other stream's")
	}
	snap, at := r.SnapshotAt()
	if string(snap) != "cdefghij" || at != 10 {
		t.Fatalf("SnapshotAt = %q %d", snap, at)
	}
}

func TestRingRestoreKeepsOffsetsAndModes(t *testing.T) {
	r := NewRing(16)
	r.Write([]byte("old"))
	r.Restore([]byte("\x1b[?2004h"), []byte("held"), 1000)
	if r.Total() != 1000 || r.Start() != 996 {
		t.Fatalf("total %d start %d", r.Total(), r.Start())
	}
	if b, ok := r.Since(998); !ok || string(b) != "ld" {
		t.Fatalf("Since(998) = %q %v", b, ok)
	}
	if snap := string(r.Snapshot()); snap != "\x1b[?2004hheld" {
		t.Fatalf("snapshot %q; the mode prefix must survive a restore", snap)
	}
	r.Write([]byte("X"))
	if b, _ := r.Since(1000); string(b) != "X" {
		t.Fatalf("after restore, Since(1000) = %q", b)
	}
}

func TestRingChangedWakesOnWrite(t *testing.T) {
	r := NewRing(8)
	ch := r.Changed()
	select {
	case <-ch:
		t.Fatal("woke before any write")
	default:
	}
	r.Write([]byte("x"))
	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatal("a write did not wake the waiter")
	}
}

func TestInputsApplyOnceAndForget(t *testing.T) {
	in := NewInputs(time.Minute)
	now := time.Unix(0, 0)
	in.now = func() time.Time { return now }
	var typed []uint64
	apply := func(seq uint64) (uint64, error) {
		return in.Apply("c1", seq, func() error { typed = append(typed, seq); return nil })
	}
	for _, s := range []uint64{1, 2, 2, 1, 3} {
		if _, err := apply(s); err != nil {
			t.Fatal(err)
		}
	}
	if len(typed) != 3 {
		t.Fatalf("typed %v; a retried sequence was applied twice", typed)
	}
	if last, _ := apply(0); last != 3 {
		t.Fatalf("query = %d; want 3", last)
	}
	// A failed write is not applied: the retry goes through.
	boom := errors.New("boom")
	if last, err := in.Apply("c1", 4, func() error { return boom }); !errors.Is(err, boom) || last != 3 {
		t.Fatalf("failed write = %d %v", last, err)
	}
	if last, _ := apply(4); last != 4 {
		t.Fatalf("retry after a failure = %d", last)
	}
	// Other clients have their own numbering.
	if last, _ := in.Apply("c2", 1, func() error { return nil }); last != 1 {
		t.Fatalf("c2 = %d", last)
	}
	now = now.Add(2 * time.Minute)
	if in.Last("c1") != 0 {
		t.Fatal("a client silent past the TTL must be forgotten")
	}
}
