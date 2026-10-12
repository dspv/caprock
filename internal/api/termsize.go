package api

import (
	"sync"
	"time"
)

// A session has one PTY and may have several terminals attached to it — the
// desktop app and a phone, say — each a different size. The PTY can only be
// one of them. It used to be whichever sent a size last, and a terminal sends
// one only when its own box changes, so a phone that typed into a session
// left the desktop drawing a 45-column agent in a 150-column pane until its
// window happened to change size (Vova, 2026-10-12).
//
// The rule now is tmux's "latest": the PTY is the size of the terminal in
// use. A terminal is in use once it types (any input frame) or says the
// person is looking at it (`{"focus":true}`: the window gained focus, the tab
// came to the front, a click in the terminal). A terminal that only attaches,
// or whose box changes while another is in use, is a viewer: its size is
// remembered and not applied, and it is drawn at the size of the one in use.
// A terminal alone on a session is in use by being there.

// ptySizes holds, per session, which attached terminal the PTY is sized for.
type ptySizes struct {
	// resize sets the PTY's size.
	resize func(id string, cols, rows int)
	// gap separates the two sizes of a repaint (repaintGap; tests shorten it).
	gap time.Duration

	mu sync.Mutex
	m  map[string]*ptySizeState
}

// ptySizeState is one session's terminals and the size its PTY was given.
type ptySizeState struct {
	// mu orders every decision and resize for the session; a repaint sleeps
	// under it, so two terminals never interleave their sizes.
	mu sync.Mutex
	id string
	// cols and rows are what the PTY was last given here; 0 before any.
	cols, rows int
	// active is the terminal in use, nil when none has a size yet.
	active *sizeConn
	// owner is the client id of the tab that last claimed the PTY by use.
	// When the active socket drops and the same tab reconnects, the new
	// socket is in use again without having to type first.
	owner string
	conns map[*sizeConn]struct{}
}

// sizeConn is one attached terminal socket.
type sizeConn struct {
	id     string
	client string
	// cols and rows are the terminal's own size; 0 before its first resize.
	cols, rows int
	// used is when it attached or last claimed the PTY.
	used time.Time
}

func newPTYSizes(resize func(id string, cols, rows int)) *ptySizes {
	return &ptySizes{resize: resize, gap: repaintGap, m: map[string]*ptySizeState{}}
}

// join registers a terminal attaching to a session.
func (p *ptySizes) join(id, client string) *sizeConn {
	p.mu.Lock()
	defer p.mu.Unlock()
	st := p.m[id]
	if st == nil {
		st = &ptySizeState{id: id, conns: map[*sizeConn]struct{}{}}
		p.m[id] = st
	}
	c := &sizeConn{id: id, client: client, used: time.Now()}
	st.mu.Lock()
	st.conns[c] = struct{}{}
	st.mu.Unlock()
	return c
}

func (p *ptySizes) state(id string) *ptySizeState {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.m[id]
}

// leave unregisters a terminal. When it was the one in use, the PTY goes to
// another socket of the same tab, else to the terminal used most recently,
// at that terminal's size.
func (p *ptySizes) leave(c *sizeConn) {
	p.mu.Lock()
	st := p.m[c.id]
	if st == nil {
		p.mu.Unlock()
		return
	}
	st.mu.Lock()
	delete(st.conns, c)
	if len(st.conns) == 0 {
		// The next terminal starts from nothing, as on a fresh session
		// (and a permission-mode restart is a fresh PTY under the same id).
		delete(p.m, c.id)
		st.mu.Unlock()
		p.mu.Unlock()
		return
	}
	p.mu.Unlock()
	defer st.mu.Unlock()
	if st.active != c {
		return
	}
	st.active = nil
	same := func(o *sizeConn) bool { return c.client != "" && o.client == c.client }
	var next *sizeConn
	for o := range st.conns {
		if o.cols == 0 {
			continue
		}
		if next == nil || (same(o) && !same(next)) || (same(o) == same(next) && o.used.After(next.used)) {
			next = o
		}
	}
	if next != nil {
		p.apply(st, next, false)
	}
}

// size records a terminal's size. It reaches the PTY when the terminal is
// in use, becomes so (claim: the frame also said focus, or it is the only
// terminal, or the tab that owned the PTY reconnecting), or is the first size
// of an attach — which repaints at the size in use either way.
func (p *ptySizes) size(c *sizeConn, cols, rows int, claim bool) {
	st := p.state(c.id)
	if st == nil {
		return
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	first := c.cols == 0
	c.cols, c.rows = cols, rows
	switch {
	case st.active == c:
		if claim {
			c.used = time.Now()
			st.owner = c.client
		}
		if st.cols != cols || st.rows != rows {
			// Its own box changed: as sent, as before.
			st.cols, st.rows = cols, rows
			p.resize(st.id, cols, rows)
		}
	case claim || st.active == nil || (first && c.client != "" && c.client == st.owner):
		c.used = time.Now()
		if c.client != "" {
			st.owner = c.client
		}
		p.apply(st, c, first)
	case first && st.cols > 0:
		// A viewer: it gets a clean screen at the size in use, not its own.
		p.repaint(st, st.cols, st.rows)
	}
}

// claim makes the terminal the one in use — it typed, or the person is
// looking at it — and gives the PTY its size if that is not the size now.
// Cheap when nothing changes: it runs on every input frame.
func (p *ptySizes) claim(c *sizeConn) {
	st := p.state(c.id)
	if st == nil {
		return
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	c.used = time.Now()
	if c.client != "" {
		st.owner = c.client
	}
	if c.cols == 0 {
		// No size yet: its first resize will find it the owner.
		return
	}
	if st.active == c && st.cols == c.cols && st.rows == c.rows {
		return
	}
	p.apply(st, c, false)
}

// apply makes c the terminal in use and the PTY its size. A change of size
// is a repaint, so the terminal taking over draws a whole screen at its
// width rather than the other terminal's lines; force repaints even when the
// size is the same (a first attach).
func (p *ptySizes) apply(st *ptySizeState, c *sizeConn, force bool) {
	st.active = c
	if force || st.cols != c.cols || st.rows != c.rows {
		p.repaint(st, c.cols, c.rows)
	}
}

// repaint gives the PTY a size so that whatever runs draws its whole screen
// again, at that size.
//
// A terminal that attaches to a running session is replayed the ring, which
// holds only the last bytes written. A TUI that redraws by difference —
// Claude Code — wrote its status rows' labels once and only their numbers
// since, so a replay that starts after the labels shows a row of bare numbers
// that never heals (owner, 2026-10-08, after an app restart). Resizing to the
// size the PTY already has sends no SIGWINCH, so nothing redrew. One row less
// and back is two real size changes, and a TUI repaints on each.
func (p *ptySizes) repaint(st *ptySizeState, cols, rows int) {
	if rows > 2 {
		p.resize(st.id, cols, rows-1)
		time.Sleep(p.gap)
	}
	p.resize(st.id, cols, rows)
	st.cols, st.rows = cols, rows
}
