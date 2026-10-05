// Package termbuf holds the recent output of a terminal: the last bytes it
// printed plus the terminal modes that output set, so a terminal that attaches
// late can be put back into the state the program expects.
//
// Two places keep one. The daemon keeps one per owned session for the browser
// tabs that connect to it, and the pty-host process (internal/ptyhost) keeps
// one for the daemon itself — after a daemon restart, that buffer is the only
// record of what the screen looked like.
//
// Every byte has an offset: the count of bytes the session printed before it.
// A client that knows how far it got asks for what came after (terminal
// protocol v2) instead of repainting the whole screen.
package termbuf

import "sync"

// Ring is a fixed-size byte buffer holding the most recent terminal output, so
// a terminal that connects late still sees recent scrollback — and the
// terminal modes that output set, which may have long since scrolled out of it.
type Ring struct {
	mu    sync.Mutex
	buf   []byte
	size  int
	modes modeTracker
	// total is the offset one past the newest byte: every byte ever written,
	// including those the ring has dropped.
	total uint64
	// changed is closed, and replaced, on every write.
	changed chan struct{}
}

// NewRing returns a ring that keeps the last size bytes.
func NewRing(size int) *Ring {
	return &Ring{buf: make([]byte, 0, size), size: size, changed: make(chan struct{})}
}

// Write appends output, dropping the oldest bytes past the ring's size.
func (r *Ring) Write(p []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.modes.feed(p)
	r.total += uint64(len(p))
	r.wake()
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

// wake tells everyone waiting on Changed. Called with mu held.
func (r *Ring) wake() {
	close(r.changed)
	r.changed = make(chan struct{})
}

// Snapshot is what a terminal attaching now should be sent: the mode prefix,
// then the scrollback.
func (r *Ring) Snapshot() []byte {
	b, _ := r.SnapshotAt()
	return b
}

// SnapshotAt is Snapshot and the offset it brings a terminal to, read together.
func (r *Ring) SnapshotAt() ([]byte, uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append(r.modes.prefix(), r.buf...), r.total
}

// Total is the offset one past the newest byte.
func (r *Ring) Total() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.total
}

// Start is the offset of the oldest byte the ring still holds.
func (r *Ring) Start() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.total - uint64(len(r.buf))
}

// Since returns a copy of every byte from offset on, and false when the ring
// no longer holds the byte at offset (or never had it: an offset past the
// end belongs to some other stream).
func (r *Ring) Since(offset uint64) ([]byte, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	start := r.total - uint64(len(r.buf))
	if offset < start || offset > r.total {
		return nil, false
	}
	return append([]byte(nil), r.buf[offset-start:]...), true
}

// Restore replaces the ring's contents with another ring's: its mode prefix,
// the bytes it held, and the offset one past them. The daemon does this with
// the pty-host's snapshot, so offsets keep counting across a daemon restart.
func (r *Ring) Restore(prefix, held []byte, total uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.modes = modeTracker{}
	r.modes.feed(prefix)
	r.modes.feed(held)
	if len(held) > r.size {
		held = held[len(held)-r.size:]
	}
	if uint64(len(held)) > total {
		total = uint64(len(held))
	}
	r.buf = append(r.buf[:0], held...)
	r.total = total
	r.wake()
}

// Changed returns a channel closed at the next write. Take it before reading,
// so a write in between is never missed.
func (r *Ring) Changed() <-chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.changed
}
