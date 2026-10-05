package termbuf

import (
	"sync"
	"time"
)

// InputTTL is how long the last applied sequence of a client is remembered
// after it was last heard from. A client that comes back later starts afresh.
const InputTTL = 120 * time.Second

// Inputs applies sequenced input exactly once per client (terminal protocol
// v2). A client numbers what it types; a retry after a dropped connection
// resends what was not acknowledged, and anything at or below the highest
// sequence already applied for that client is dropped instead of typed twice.
//
// The pty-host keeps one, so the guarantee holds across a daemon restart; the
// daemon keeps one for a session it holds itself.
type Inputs struct {
	mu   sync.Mutex
	ttl  time.Duration
	now  func() time.Time
	last map[string]applied
}

type applied struct {
	seq  uint64
	seen time.Time
}

// NewInputs returns an empty table that forgets a client after ttl.
func NewInputs(ttl time.Duration) *Inputs {
	return &Inputs{ttl: ttl, now: time.Now, last: map[string]applied{}}
}

// Apply calls write for a sequence newer than the client's last, and returns
// the client's last applied sequence afterwards. Sequence 0 applies nothing:
// it asks for the last. A failed write leaves the last where it was, so the
// retry is applied.
func (in *Inputs) Apply(client string, seq uint64, write func() error) (uint64, error) {
	in.mu.Lock()
	defer in.mu.Unlock()
	now := in.now()
	in.prune(now)
	a := in.last[client]
	if seq > a.seq {
		if err := write(); err != nil {
			return a.seq, err
		}
		a.seq = seq
	}
	if seq > 0 || a.seq > 0 {
		a.seen = now
		in.last[client] = a
	}
	return a.seq, nil
}

// Last is the client's last applied sequence, 0 when it is not known.
func (in *Inputs) Last(client string) uint64 {
	in.mu.Lock()
	defer in.mu.Unlock()
	in.prune(in.now())
	return in.last[client].seq
}

func (in *Inputs) prune(now time.Time) {
	for k, a := range in.last {
		if now.Sub(a.seen) > in.ttl {
			delete(in.last, k)
		}
	}
}
