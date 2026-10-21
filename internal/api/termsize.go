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
//
// A terminal that goes out of sight (`{"blur":true}`: its page was hidden, a
// phone locked or went to the background, an app tab went behind another)
// gives the PTY back at once: it goes to the terminal used most recently among
// those still in sight, at that terminal's last size. A socket that closes
// does the same. Waiting for the socket to die took up to 35 s on a phone that
// locked, and never came on one whose browser kept answering pings in the
// background, so the desktop stayed drawn at the phone's width until the
// session was reopened (Vova, 2026-10-13). A terminal out of sight is still a
// viewer; its next claim brings it back.

// ptySizes holds, per session, which attached terminal the PTY is sized for.
type ptySizes struct {
	// resize sets the PTY's size.
	resize func(id string, cols, rows int)
	// gap separates the two sizes of a repaint (repaintGap; tests shorten it):
	// the least time between them, counted from the session's first output
	// after the narrower size when it has a way to tell (ptySizeState.drew).
	gap time.Duration
	// wait is the most a repaint waits for that output (repaintWait).
	wait time.Duration

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
	// drew hands out a channel closed by the session's next output (its
	// ring's Changed); nil until a terminal attaches through termv2.
	drew func() <-chan struct{}
}

// sizeConn is one attached terminal socket.
type sizeConn struct {
	id     string
	client string
	// cols and rows are the terminal's own size; 0 before its first resize.
	cols, rows int
	// used is when it attached or last claimed the PTY.
	used time.Time
	// away is set while the terminal is out of sight (a blur frame) and
	// cleared by its next claim; the PTY does not go to an away terminal
	// while one in sight has a size.
	away bool
}

func newPTYSizes(resize func(id string, cols, rows int)) *ptySizes {
	return &ptySizes{resize: resize, gap: repaintGap, wait: repaintWait, m: map[string]*ptySizeState{}}
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

// watch gives a session's repaints a way to see its output: changed is its
// ring's Changed. See repaint.
func (p *ptySizes) watch(id string, changed func() <-chan struct{}) {
	st := p.state(id)
	if st == nil {
		return
	}
	st.mu.Lock()
	st.drew = changed
	st.mu.Unlock()
}

// redraw repaints the session at the size its PTY has, when it has one: a
// terminal that was just sent the ring's snapshot mid-session (it fell
// further behind than the ring reaches) holds only the last bytes written,
// which for a TUI that redraws by difference are the cells that changed.
func (p *ptySizes) redraw(c *sizeConn) {
	st := p.state(c.id)
	if st == nil {
		return
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.cols > 0 && st.rows > 0 {
		p.repaint(st, st.cols, st.rows)
	}
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
	if next := st.next(c, true); next != nil {
		p.apply(st, next, false)
	}
}

// release is a terminal going out of sight. When it was the one in use and a
// terminal in sight has a size, the PTY goes to the one of those used most
// recently; with none it stays, so a lone terminal keeps sizing its PTY.
func (p *ptySizes) release(c *sizeConn) {
	st := p.state(c.id)
	if st == nil {
		return
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	c.away = true
	if st.active != c {
		return
	}
	if next := st.next(c, false); next != nil {
		// The PTY is the other terminal's now, so a phone whose socket died
		// while it was locked does not take it back by reconnecting.
		st.owner = next.client
		p.apply(st, next, false)
	}
}

// next picks who the PTY goes to when c stops being the terminal in use:
// another socket of c's tab first, else the terminal used most recently;
// one in sight before one out of sight, which is picked only when anyAway.
// A terminal with no size yet is never picked.
func (st *ptySizeState) next(c *sizeConn, anyAway bool) *sizeConn {
	same := func(o *sizeConn) bool { return c.client != "" && o.client == c.client }
	var next *sizeConn
	for o := range st.conns {
		if o == c || o.cols == 0 || (o.away && !anyAway) {
			continue
		}
		switch {
		case next == nil,
			next.away && !o.away,
			next.away == o.away && same(o) && !same(next),
			next.away == o.away && same(o) == same(next) && o.used.After(next.used):
			next = o
		}
	}
	return next
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
	if claim {
		c.away = false
	}
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
	c.away = false
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
// size the PTY already has sends no SIGWINCH, so nothing redrew. One column
// less and back is two real size changes, and a TUI repaints on each.
//
// A column, not a row. It was one row less, and Claude Code (2.1) clears the
// viewport on a shrink by erasing as many rows as it now thinks it has, from
// the top: one short of the terminal's, whose size never changed. Growing
// back clears nothing, so the bottom row kept whatever was drawn there before
// — a stale subagent row under the list after every resume (users,
// 2026-10-20; reproduced with the fake claude, which clears the same way). A
// width change clears all the rows on both steps.
//
// And the program has to see the narrower size before the size comes back.
// Two SIGWINCHes that arrive while a program's event loop is busy are one
// signal by the time it looks, and the size it then reads is the one it
// already drew at: no resize event, no repaint, and the terminal keeps the
// replay's bare changed cells for good — a status line of lone digits, the
// mode line's words gone, a task row without its labels (owner, 2026-10-21,
// on a loaded Mac; a Node program blocked 120 ms in every 150 saw two of five
// 40 ms repaints, the other three not at all). So the size comes back only
// once the program has drawn something after the narrower one, or after
// repaintWait for one that does not redraw on a resize (an idle shell), and
// never sooner than gap after that.
func (p *ptySizes) repaint(st *ptySizeState, cols, rows int) {
	if cols > 2 {
		var drew <-chan struct{}
		if st.drew != nil {
			drew = st.drew()
		}
		p.resize(st.id, cols-1, rows)
		p.settle(drew)
	}
	p.resize(st.id, cols, rows)
	st.cols, st.rows = cols, rows
}

// settle waits for drew (nil: not at all) up to p.wait, then p.gap.
func (p *ptySizes) settle(drew <-chan struct{}) {
	if drew != nil && p.wait > 0 {
		t := time.NewTimer(p.wait)
		select {
		case <-drew:
		case <-t.C:
		}
		t.Stop()
	}
	time.Sleep(p.gap)
}
