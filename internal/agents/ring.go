package agents

import "sync"

// ring is a fixed-size byte buffer holding the most recent terminal output, so a
// terminal that connects late still sees recent scrollback.
type ring struct {
	mu   sync.Mutex
	buf  []byte
	size int
}

func newRing(size int) *ring { return &ring{buf: make([]byte, 0, size), size: size} }

func (r *ring) write(p []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(p) >= r.size {
		r.buf = append(r.buf[:0], p[len(p)-r.size:]...)
		return
	}
	if len(r.buf)+len(p) <= r.size {
		r.buf = append(r.buf, p...)
		return
	}
	drop := len(r.buf) + len(p) - r.size
	r.buf = append(r.buf[drop:], p...)
}

func (r *ring) snapshot() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]byte, len(r.buf))
	copy(out, r.buf)
	return out
}
