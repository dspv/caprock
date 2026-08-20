// Terminal fan-out: the ring buffer that gives a late-connecting browser its
// scrollback, and the subscriber set that feeds live output to every open
// terminal tab.
//
// This is where a "send on closed channel" panic would live — pump broadcasts
// while wait closes every subscriber and a browser tab can unsubscribe at any
// moment. A panic here takes the whole daemon down, not one request.
package agents

import (
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRingKeepsTheMostRecentBytes(t *testing.T) {
	r := newRing(10)
	r.write([]byte("abc"))
	if got := string(r.snapshot()); got != "abc" {
		t.Fatalf("snapshot = %q; want %q", got, "abc")
	}
	// Overflow drops from the front — a terminal shows the newest output.
	r.write([]byte("defghijkl"))
	got := string(r.snapshot())
	if len(got) > 10 {
		t.Errorf("snapshot is %d bytes; the ring is capped at 10", len(got))
	}
	if !strings.HasSuffix(got, "defghijkl") {
		t.Errorf("snapshot = %q; want it to end with the newest bytes", got)
	}
}

// A single write larger than the whole ring must keep its tail, not overflow
// or panic — one big paste does exactly this.
func TestRingHandlesAnOversizedWrite(t *testing.T) {
	r := newRing(8)
	r.write([]byte(strings.Repeat("x", 3)))
	r.write([]byte("0123456789ABCDEF"))
	got := string(r.snapshot())
	if len(got) != 8 {
		t.Fatalf("snapshot is %d bytes; want the ring size 8", len(got))
	}
	if got != "89ABCDEF" {
		t.Errorf("snapshot = %q; want the last 8 bytes", got)
	}
}

// A snapshot must stay valid while the ring keeps moving — the browser holds
// one while output streams in.
//
// Note what this does and does not prove. Returning r.buf directly would still
// pass: `write` rebuilds the slice with append rather than editing bytes in
// place (verified — the backing pointer moves on overflow), so a stale
// reference is not corrupted by later writes. The copy in snapshot() is
// therefore defence in depth, not the thing keeping this green. What is
// actually asserted is that a caller who mutates its own snapshot cannot reach
// into the ring, which is the property the terminal endpoint relies on.
func TestRingSnapshotDoesNotShareMemoryWithTheRing(t *testing.T) {
	r := newRing(8)
	r.write([]byte("AAAAAAAA"))
	snap := r.snapshot()
	if string(snap) != "AAAAAAAA" {
		t.Fatalf("snapshot = %q", snap)
	}
	snap[0] = 'Z'
	if got := string(r.snapshot()); got[0] == 'Z' {
		t.Errorf("mutating a snapshot changed the ring to %q; they share an array", got)
	}
}

func TestRingIsRaceFree(t *testing.T) {
	r := newRing(1024)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				r.write([]byte("chunk"))
				_ = r.snapshot()
			}
		}()
	}
	wg.Wait()
}

// newTestAgent builds an Agent without spawning a process, so the subscriber
// logic can be driven directly.
func newTestAgent() *Agent {
	return &Agent{
		SessionID: "s-1",
		ring:      newRing(1 << 10),
		subs:      map[chan []byte]struct{}{},
		done:      make(chan struct{}),
	}
}

// broadcast mirrors what pump does with a chunk, which is the half of the
// contract a test can drive without a live PTY.
func (a *Agent) broadcast(chunk []byte) {
	a.ring.write(chunk)
	a.mu.Lock()
	for ch := range a.subs {
		select {
		case ch <- chunk:
		default:
		}
	}
	a.mu.Unlock()
}

func TestSubscribeReceivesOutput(t *testing.T) {
	a := newTestAgent()
	ch, cancel := a.Subscribe()
	defer cancel()

	a.broadcast([]byte("hello"))
	select {
	case got := <-ch:
		if string(got) != "hello" {
			t.Errorf("received %q; want %q", got, "hello")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("subscriber received nothing")
	}
}

// Every open terminal tab is its own subscriber and all of them must see the
// same bytes.
func TestEverySubscriberGetsTheSameChunk(t *testing.T) {
	a := newTestAgent()
	var chans []<-chan []byte
	for i := 0; i < 3; i++ {
		ch, cancel := a.Subscribe()
		defer cancel()
		chans = append(chans, ch)
	}
	a.broadcast([]byte("x"))
	for i, ch := range chans {
		select {
		case got := <-ch:
			if string(got) != "x" {
				t.Errorf("subscriber %d got %q", i, got)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("subscriber %d received nothing", i)
		}
	}
}

// Closing a browser tab must remove the subscriber, or the agent broadcasts to
// a channel nobody reads for the life of the process.
func TestCancelRemovesTheSubscriber(t *testing.T) {
	a := newTestAgent()
	_, cancel := a.Subscribe()

	a.mu.Lock()
	before := len(a.subs)
	a.mu.Unlock()
	if before != 1 {
		t.Fatalf("%d subscribers after Subscribe; want 1", before)
	}

	cancel()
	a.mu.Lock()
	after := len(a.subs)
	a.mu.Unlock()
	if after != 0 {
		t.Errorf("%d subscribers after cancel; want 0 — this is a leak", after)
	}
}

// A browser can close twice (unload plus an explicit close), and the second
// cancel must not panic on an already-closed channel.
func TestCancelIsIdempotent(t *testing.T) {
	a := newTestAgent()
	_, cancel := a.Subscribe()
	cancel()
	cancel() // must not panic
}

// Subscribing to an agent whose process already exited returns a closed
// channel rather than one that never delivers — the terminal shows scrollback
// and stops, instead of spinning forever.
func TestSubscribeAfterExitReturnsAClosedChannel(t *testing.T) {
	a := newTestAgent()
	a.mu.Lock()
	a.exited = true
	a.mu.Unlock()

	ch, cancel := a.Subscribe()
	defer cancel()
	select {
	case _, open := <-ch:
		if open {
			t.Error("channel delivered a value for an exited agent")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("channel from an exited agent never closed")
	}
}

// A subscriber that stops reading must not stall the pump: output is dropped
// for that tab rather than blocking every other terminal and the recorder.
func TestSlowSubscriberDoesNotBlockTheBroadcast(t *testing.T) {
	a := newTestAgent()
	_, cancel := a.Subscribe() // never read from
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 1000; i++ {
			a.broadcast([]byte("spam"))
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("broadcast blocked on a subscriber that stopped reading")
	}
}

// The dangerous interleaving: output arriving while the process exits and a
// tab unsubscribes. Any ordering mistake here is a send on a closed channel,
// which panics the daemon rather than failing one request.
func TestBroadcastAndCancelAreRaceFree(t *testing.T) {
	a := newTestAgent()
	var wg sync.WaitGroup

	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 40; j++ {
				ch, cancel := a.Subscribe()
				go func() {
					for range ch {
					}
				}()
				a.broadcast([]byte("data"))
				cancel()
			}
		}()
	}
	wg.Wait()
}

func TestExitedReportsTheCode(t *testing.T) {
	a := newTestAgent()
	if code, done := a.Exited(); done || code != 0 {
		t.Errorf("Exited = (%d, %v) before exit; want (0, false)", code, done)
	}
	a.mu.Lock()
	a.exit, a.exited = 3, true
	a.mu.Unlock()
	if code, done := a.Exited(); !done || code != 3 {
		t.Errorf("Exited = (%d, %v); want (3, true)", code, done)
	}
}
