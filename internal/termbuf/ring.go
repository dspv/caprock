// Package termbuf holds the recent output of a terminal: the last bytes it
// printed plus the terminal modes that output set, so a terminal that attaches
// late can be put back into the state the program expects.
//
// Two places keep one. The daemon keeps one per owned session for the browser
// tabs that connect to it, and the pty-host process (internal/ptyhost) keeps
// one for the daemon itself — after a daemon restart, that buffer is the only
// record of what the screen looked like.
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
}

// NewRing returns a ring that keeps the last size bytes.
func NewRing(size int) *Ring { return &Ring{buf: make([]byte, 0, size), size: size} }

// Write appends output, dropping the oldest bytes past the ring's size.
func (r *Ring) Write(p []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.modes.feed(p)
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

// Snapshot is what a terminal attaching now should be sent: the mode prefix,
// then the scrollback.
func (r *Ring) Snapshot() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append(r.modes.prefix(), r.buf...)
}
