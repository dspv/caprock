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
//
// The bytes live in one array allocated up front and written in a circle: a
// write copies into it, wrapping at the end, and allocates nothing. Only a
// reader that wants the bytes in one piece (Since, SnapshotAt) gets a fresh
// slice, put together from the up to two runs the held bytes make.
type Ring struct {
	mu sync.Mutex
	// buf is the backing array, len(buf) == size. The held bytes are the n
	// starting at index head, running past the end of buf back to its start.
	buf  []byte
	head int
	n    int
	size int
	// base is the modes in force where the held bytes start: what the output
	// set in the bytes the ring has already dropped. The snapshot opens with
	// it and then replays the held bytes, so a mode is switched where the
	// output switched it — text printed before an app entered the alternate
	// screen lands on the normal screen, not on the alternate one.
	base modeTracker
	// total is the offset one past the newest byte: every byte ever written,
	// including those the ring has dropped.
	total uint64
	// changed is the channel Changed handed out since the last write, which
	// the next write closes; nil while nobody has asked. It is made only when
	// asked for, so output nobody is watching costs no channel per write.
	changed chan struct{}
}

// NewRing returns a ring that keeps the last size bytes.
func NewRing(size int) *Ring {
	size = max(size, 0)
	return &Ring{buf: make([]byte, size), size: size}
}

// Write appends output, dropping the oldest bytes past the ring's size.
func (r *Ring) Write(p []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.total += uint64(len(p))
	r.wake()
	if len(p) >= r.size {
		r.drop(r.n)
		r.base.feed(p[:len(p)-r.size])
		copy(r.buf, p[len(p)-r.size:])
		r.head, r.n = 0, r.size
		return
	}
	if over := r.n + len(p) - r.size; over > 0 {
		r.drop(over)
	}
	// Now n+len(p) <= size: the free space starts at head+n (mod size) and p
	// wraps at most once.
	at := r.head + r.n
	if at >= r.size {
		at -= r.size
	}
	k := copy(r.buf[at:], p)
	copy(r.buf, p[k:])
	r.n += len(p)
}

// drop lets the oldest k held bytes go, feeding them to base first so the
// modes they set outlive them. Called with mu held, k <= n.
func (r *Ring) drop(k int) {
	a, b := r.span(0, k)
	r.base.feed(a)
	r.base.feed(b)
	r.head += k
	if r.head >= r.size {
		r.head -= r.size
	}
	r.n -= k
}

// span is the held bytes [from, from+k) as up to two runs of buf, in order.
// Called with mu held, from+k <= n.
func (r *Ring) span(from, k int) (a, b []byte) {
	if k == 0 {
		return nil, nil
	}
	at := r.head + from
	if at >= r.size {
		at -= r.size
	}
	if at+k <= r.size {
		return r.buf[at : at+k], nil
	}
	return r.buf[at:], r.buf[:k-(r.size-at)]
}

// held is a contiguous copy of the held bytes [from, n), after pre. Called
// with mu held.
func (r *Ring) held(pre []byte, from int) []byte {
	a, b := r.span(from, r.n-from)
	out := make([]byte, 0, len(pre)+len(a)+len(b))
	return append(append(append(out, pre...), a...), b...)
}

// wake tells everyone waiting on Changed. Called with mu held.
//
// A channel exists only once Changed has handed it out, and every one handed
// out is closed here, at the first write after: the same promise as replacing
// the channel on every write, without making one nobody will read.
func (r *Ring) wake() {
	if r.changed != nil {
		close(r.changed)
		r.changed = nil
	}
}

// Snapshot is what a terminal attaching now should be sent: the modes in force
// where the scrollback starts, then the scrollback.
func (r *Ring) Snapshot() []byte {
	b, _ := r.SnapshotAt()
	return b
}

// SnapshotAt is Snapshot and the offset it brings a terminal to, read together.
func (r *Ring) SnapshotAt() ([]byte, uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.held(r.base.prefix(), 0), r.total
}

// Mode reports the last value the output set for one of the tracked DEC
// private modes (trackedModes), and whether the output has set it at all.
// The daemon reads 2004 before it types a message into a session: an app
// that turned bracketed paste on is sent the message as a paste. It reads
// the held bytes on each call, which is rare, rather than every write twice.
func (r *Ring) Mode(n int) (on, seen bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	m := r.base.clone()
	a, b := r.span(0, r.n)
	m.feed(a)
	m.feed(b)
	on, seen = m.set[n]
	return on, seen
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
	return r.total - uint64(r.n)
}

// Since returns a copy of every byte from offset on, and false when the ring
// no longer holds the byte at offset (or never had it: an offset past the
// end belongs to some other stream).
func (r *Ring) Since(offset uint64) ([]byte, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	start := r.total - uint64(r.n)
	if offset < start || offset > r.total {
		return nil, false
	}
	return r.held(nil, int(offset-start)), true
}

// Restore replaces the ring's contents with another ring's: its mode prefix,
// the bytes it held, and the offset one past them. The daemon does this with
// the pty-host's snapshot, so offsets keep counting across a daemon restart.
func (r *Ring) Restore(prefix, held []byte, total uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.base = modeTracker{}
	r.base.feed(prefix)
	if len(held) > r.size {
		r.base.feed(held[:len(held)-r.size])
		held = held[len(held)-r.size:]
	}
	if uint64(len(held)) > total {
		total = uint64(len(held))
	}
	copy(r.buf, held)
	r.head, r.n = 0, len(held)
	r.total = total
	r.wake()
}

// Changed returns a channel closed at the next write (or restore). Take it
// before reading, so a write in between is never missed.
func (r *Ring) Changed() <-chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.changed == nil {
		r.changed = make(chan struct{})
	}
	return r.changed
}
