// Package bus is the in-process fan-out for live frames: every stored event,
// session change, or alert is published once and delivered to every subscriber
// (WebSocket clients, the loop detector, tests). Slow subscribers are dropped
// rather than allowed to stall the writer — the UI can always catch up via REST.
//
// Every published frame is numbered (Seq) and kept in a replay ring, so a
// /v1/live client that reconnects gets exactly what it missed (.ai/21-app.md
// § Live replay).
package bus

import (
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// ReplayFrames is the most frames the replay ring holds.
	ReplayFrames = 2000
	// ReplayAge is how long a frame stays in the replay ring.
	ReplayAge = 10 * time.Minute
)

// FrameType matches the WS contract: event | session | alert.
type FrameType string

const (
	FrameEvent   FrameType = "event"
	FrameSession FrameType = "session"
	FrameAlert   FrameType = "alert"
	FrameStats   FrameType = "stats" // per-session stats snapshot; UI convenience
	// FramePermission says an owned session started or stopped waiting on a
	// permission prompt: {session_id, permission}, permission null when it
	// stopped.
	FramePermission FrameType = "permission"
	// FrameNotify is a notification for the app (alerts.Notification): what
	// Telegram would say, as plain text, with the prompt's answers when there
	// is one Caprock can give.
	FrameNotify FrameType = "notify"
)

// Frame is what goes over /v1/live. Seq is set by Publish: one more than the
// frame before it.
type Frame struct {
	Type FrameType `json:"type"`
	Seq  uint64    `json:"seq,omitempty"`
	Data any       `json:"data"`
}

// Marshal encodes the frame once for all subscribers.
func (f Frame) Marshal() ([]byte, error) { return json.Marshal(f) }

// Bus fans frames out to subscribers.
type Bus struct {
	mu   sync.RWMutex
	subs map[*Subscriber]struct{}
	// Dropped counts frames discarded because a subscriber's buffer was full.
	dropped atomic.Uint64

	// The replay ring, guarded by mu (write lock). seq is the newest frame's
	// number; floor the newest one no longer held, so the ring holds exactly
	// (floor, seq]. Both start at the clock in microseconds, so a number
	// handed out by an earlier daemon is never inside a later one's range,
	// and stay below 2^53 (exact in JavaScript).
	ring  []held
	seq   uint64
	floor uint64
	now   func() time.Time
}

// held is a frame in the replay ring and when it was published.
type held struct {
	f  Frame
	at time.Time
}

// Subscriber receives frames on C. Close it with Unsubscribe.
type Subscriber struct {
	C   chan Frame
	bus *Bus
	lag chan struct{}
}

// Lagged is signalled when a frame was dropped because C was full, so a
// subscriber that can replay (Since) catches up even when no later frame
// arrives to show the gap.
func (s *Subscriber) Lagged() <-chan struct{} { return s.lag }

// New creates a bus.
func New() *Bus { return newAt(time.Now) }

func newAt(now func() time.Time) *Bus {
	start := uint64(now().UnixMicro())
	return &Bus{subs: map[*Subscriber]struct{}{}, seq: start, floor: start, now: now}
}

// Subscribe registers a subscriber with the given buffer size.
func (b *Bus) Subscribe(buffer int) *Subscriber {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.subscribeLocked(buffer)
}

func (b *Bus) subscribeLocked(buffer int) *Subscriber {
	if buffer <= 0 {
		buffer = 256
	}
	s := &Subscriber{C: make(chan Frame, buffer), bus: b, lag: make(chan struct{}, 1)}
	b.subs[s] = struct{}{}
	return s
}

// Resume subscribes and, in the same step, reports where the subscriber
// starts. With since nil it starts at the newest frame (seq). With since set,
// missed is every frame after since, in order, and ok is false when the ring
// no longer holds them (or never did) — the client must refetch. Frames on
// the subscriber's channel always come after seq.
func (b *Bus) Resume(buffer int, since *uint64) (s *Subscriber, missed []Frame, seq uint64, ok bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	s = b.subscribeLocked(buffer)
	if since == nil {
		return s, nil, b.seq, true
	}
	missed, ok = b.sinceLocked(*since)
	return s, missed, b.seq, ok
}

// Since returns the frames after since, in order, and the newest seq; ok is
// false when the ring does not hold all of them.
func (b *Bus) Since(since uint64) (frames []Frame, seq uint64, ok bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	frames, ok = b.sinceLocked(since)
	return frames, b.seq, ok
}

func (b *Bus) sinceLocked(since uint64) ([]Frame, bool) {
	b.evictLocked()
	if since < b.floor || since > b.seq {
		return nil, false
	}
	held := b.ring[since-b.floor:]
	out := make([]Frame, len(held))
	for i, h := range held {
		out[i] = h.f
	}
	return out, true
}

// evictLocked drops frames past the ring's size or age.
func (b *Bus) evictLocked() {
	cutoff := b.now().Add(-ReplayAge)
	n := 0
	for n < len(b.ring) && (len(b.ring)-n > ReplayFrames || b.ring[n].at.Before(cutoff)) {
		b.floor = b.ring[n].f.Seq
		b.ring[n] = held{} // let the frame's data go
		n++
	}
	b.ring = b.ring[n:]
}

// Unsubscribe removes the subscriber and closes its channel.
func (s *Subscriber) Unsubscribe() {
	s.bus.mu.Lock()
	if _, ok := s.bus.subs[s]; ok {
		delete(s.bus.subs, s)
		close(s.C)
	}
	s.bus.mu.Unlock()
}

// Publish numbers a frame, keeps it for replay, and delivers it to every
// subscriber without blocking. Numbering and delivery share one lock, so every
// subscriber receives frames in seq order.
func (b *Bus) Publish(f Frame) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.seq++
	f.Seq = b.seq
	b.ring = append(b.ring, held{f: f, at: b.now()})
	b.evictLocked()
	for s := range b.subs {
		select {
		case s.C <- f:
		default:
			b.dropped.Add(1)
			select {
			case s.lag <- struct{}{}:
			default:
			}
		}
	}
}

// Subscribers returns the current subscriber count.
func (b *Bus) Subscribers() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subs)
}
