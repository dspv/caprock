// Package bus is the in-process fan-out for live frames: every stored event,
// session change, or alert is published once and delivered to every subscriber
// (WebSocket clients, the loop detector, tests). Slow subscribers are dropped
// rather than allowed to stall the writer — the UI can always catch up via REST.
package bus

import (
	"encoding/json"
	"sync"
)

// FrameType matches the WS contract: event | session | alert.
type FrameType string

const (
	FrameEvent   FrameType = "event"
	FrameSession FrameType = "session"
	FrameAlert   FrameType = "alert"
	FrameStats   FrameType = "stats" // per-session stats snapshot; UI convenience
)

// Frame is what goes over /v1/live.
type Frame struct {
	Type FrameType `json:"type"`
	Data any       `json:"data"`
}

// Marshal encodes the frame once for all subscribers.
func (f Frame) Marshal() ([]byte, error) { return json.Marshal(f) }

// Bus fans frames out to subscribers.
type Bus struct {
	mu   sync.RWMutex
	subs map[*Subscriber]struct{}
	// Dropped counts frames discarded because a subscriber's buffer was full.
	dropped uint64
}

// Subscriber receives frames on C. Close it with Unsubscribe.
type Subscriber struct {
	C   chan Frame
	bus *Bus
}

// New creates a bus.
func New() *Bus { return &Bus{subs: map[*Subscriber]struct{}{}} }

// Subscribe registers a subscriber with the given buffer size.
func (b *Bus) Subscribe(buffer int) *Subscriber {
	if buffer <= 0 {
		buffer = 256
	}
	s := &Subscriber{C: make(chan Frame, buffer), bus: b}
	b.mu.Lock()
	b.subs[s] = struct{}{}
	b.mu.Unlock()
	return s
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

// Publish delivers a frame to every subscriber without blocking.
func (b *Bus) Publish(f Frame) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for s := range b.subs {
		select {
		case s.C <- f:
		default:
			b.dropped++
		}
	}
}

// Subscribers returns the current subscriber count.
func (b *Bus) Subscribers() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subs)
}
