package agents

import (
	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/termbuf"
)

// ring is the daemon's copy of an owned session's recent output, for browser
// tabs that connect late. The buffer and the mode tracking live in termbuf,
// shared with the pty-host process, which keeps the same thing for the daemon.
//
// A session held by a pty-host brings a ring of its own, restored from the
// holder's and kept current by the connection to it, so offsets continue
// across daemon restarts; then shared is true and pump leaves it alone.
type ring struct {
	r      *termbuf.Ring
	shared bool
}

func newRing(size int) *ring { return &ring{r: termbuf.NewRing(size)} }

// ringFor is the session's own ring when it keeps one, else a new one.
func ringFor(sess ptyman.Session, size int) *ring {
	if rs, ok := sess.(ptyman.Ringed); ok && rs.Ring() != nil {
		return &ring{r: rs.Ring(), shared: true}
	}
	return newRing(size)
}

func (r *ring) write(p []byte) {
	if !r.shared {
		r.r.Write(p)
	}
}

func (r *ring) snapshot() []byte { return r.r.Snapshot() }
