package agents

import "github.com/dspv/caprock/internal/termbuf"

// ring is the daemon's copy of an owned session's recent output, for browser
// tabs that connect late. The buffer and the mode tracking live in termbuf,
// shared with the pty-host process, which keeps the same thing for the daemon.
type ring struct{ r *termbuf.Ring }

func newRing(size int) *ring { return &ring{r: termbuf.NewRing(size)} }

func (r *ring) write(p []byte) { r.r.Write(p) }

func (r *ring) snapshot() []byte { return r.r.Snapshot() }
