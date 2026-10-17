package termbuf

import (
	"bytes"
	"fmt"
	"math/rand/v2"
	"sync"
	"testing"
	"time"
)

// refRing is the ring as a definition rather than a data structure: every
// byte written since the last restore kept in full, the held bytes its last
// size, and the mode prefix what one tracker reads over the restored prefix
// and everything dropped. The circular ring must answer exactly like it.
type refRing struct {
	size   int
	prefix []byte // the prefix the last Restore was given
	stream []byte // every byte since then, the restored held bytes first
	total  uint64
}

func (f *refRing) write(p []byte) {
	f.stream = append(f.stream, p...)
	f.total += uint64(len(p))
}

func (f *refRing) restore(prefix, held []byte, total uint64) {
	f.prefix = append([]byte(nil), prefix...)
	f.stream = append([]byte(nil), held...)
	f.total = max(total, uint64(min(len(held), f.size)))
}

func (f *refRing) cut() int { return max(len(f.stream)-f.size, 0) }

func (f *refRing) held() []byte { return f.stream[f.cut():] }

func (f *refRing) base() modeTracker {
	var m modeTracker
	m.feed(f.prefix)
	m.feed(f.stream[:f.cut()])
	return m
}

func (f *refRing) snapshot() []byte {
	m := f.base()
	return append(m.prefix(), f.held()...)
}

func (f *refRing) start() uint64 { return f.total - uint64(len(f.held())) }

// pieces are what the random output is made of: text, the tracked modes
// whole, and sequences a chunk boundary can cut anywhere.
var pieces = []string{
	"hello ", "x", "\r\n", strings64,
	"\x1b[?2004h", "\x1b[?2004l", "\x1b[?1049h", "\x1b[?1049l",
	"\x1b[?1000;1006h", "\x1b[?1003h", "\x1b[?1002l", "\x1b[?25l", "\x1b[?1h",
	"\x1b[2J", "\x1b", "\x1b[", "\x1b[?", "\x1b[3;1H",
}

const strings64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func randomOutput(rng *rand.Rand, n int) []byte {
	var b []byte
	for len(b) < n {
		b = append(b, pieces[rng.IntN(len(pieces))]...)
	}
	return b[:n]
}

func checkAgainst(t *testing.T, step string, r *Ring, f *refRing, rng *rand.Rand) {
	t.Helper()
	if r.Total() != f.total || r.Start() != f.start() {
		t.Fatalf("%s: total %d start %d; want %d %d", step, r.Total(), r.Start(), f.total, f.start())
	}
	snap, at := r.SnapshotAt()
	if want := f.snapshot(); !bytes.Equal(snap, want) || at != f.total {
		t.Fatalf("%s: snapshot\n %q @%d\nwant\n %q @%d", step, snap, at, want, f.total)
	}
	// Every offset the ring holds, the ends and one each side of them.
	held := f.held()
	offs := []uint64{f.start(), f.total, f.total - uint64(len(held)/2)}
	if f.start() > 0 {
		offs = append(offs, f.start()-1)
	}
	offs = append(offs, f.total+1, f.start()+uint64(rng.IntN(len(held)+1)))
	for _, off := range offs {
		got, ok := r.Since(off)
		inside := off >= f.start() && off <= f.total
		if ok != inside {
			t.Fatalf("%s: Since(%d) ok=%v; want %v (start %d total %d)", step, off, ok, inside, f.start(), f.total)
		}
		if inside && !bytes.Equal(got, held[off-f.start():]) {
			t.Fatalf("%s: Since(%d) = %q; want %q", step, off, got, held[off-f.start():])
		}
	}
	all := f.base()
	all.feed(held)
	for _, m := range trackedModes {
		on, seen := r.Mode(m)
		won, wseen := all.set[m]
		if on != won || seen != wseen {
			t.Fatalf("%s: Mode(%d) = %v %v; want %v %v", step, m, on, seen, won, wseen)
		}
	}
}

// After any run of writes and restores, of any sizes, wrapping the array any
// number of times, the ring answers exactly as the reference does.
func TestRingMatchesTheReferenceAcrossWraps(t *testing.T) {
	for _, size := range []int{0, 1, 2, 7, 16, 61, 256} {
		for seed := range uint64(40) {
			t.Run(fmt.Sprintf("size=%d/seed=%d", size, seed), func(t *testing.T) {
				rng := rand.New(rand.NewPCG(seed, uint64(size)))
				r, f := NewRing(size), &refRing{size: size}
				for step := range 300 {
					switch op := rng.IntN(20); {
					case op == 0:
						prefix := randomOutput(rng, rng.IntN(24))
						held := randomOutput(rng, rng.IntN(2*size+2))
						total := uint64(rng.IntN(4 * (size + 1)))
						r.Restore(prefix, held, total)
						f.restore(prefix, held, total)
					case op < 4: // a write the size of the ring or more
						p := randomOutput(rng, size+rng.IntN(size+2))
						r.Write(p)
						f.write(p)
					default:
						p := randomOutput(rng, rng.IntN(size/2+3))
						r.Write(p)
						f.write(p)
					}
					checkAgainst(t, fmt.Sprintf("step %d", step), r, f, rng)
				}
			})
		}
	}
}

// Offsets keep counting through many wraps, and a chunk that straddles the
// end of the array reads back whole.
func TestRingOffsetsAcrossTheWrap(t *testing.T) {
	r := NewRing(10)
	r.Write([]byte("0123456"))
	r.Write([]byte("789ab")) // wraps: "ab" at the start of the array
	if r.Start() != 2 || r.Total() != 12 {
		t.Fatalf("start %d total %d", r.Start(), r.Total())
	}
	if b, ok := r.Since(6); !ok || string(b) != "6789ab" {
		t.Fatalf("Since(6) across the wrap = %q %v", b, ok)
	}
	if b, ok := r.Since(11); !ok || string(b) != "b" {
		t.Fatalf("Since(11) = %q %v", b, ok)
	}
	for i := range 1000 {
		r.Write([]byte{byte('a' + i%26)})
	}
	if r.Total() != 1012 || r.Start() != 1002 {
		t.Fatalf("after 100 wraps: start %d total %d", r.Start(), r.Total())
	}
	b, _ := r.Since(1002)
	if want := "cdefghijkl"; string(b) != want { // i = 990..999
		t.Fatalf("Since(1002) = %q; want %q", b, want)
	}
}

// Writing never allocates once the ring exists, with nobody watching.
func TestRingWriteDoesNotAllocate(t *testing.T) {
	r := NewRing(256 << 10)
	p := bytes.Repeat([]byte("x"), 16<<10)
	r.Write(bytes.Repeat([]byte("y"), 256<<10))
	if n := testing.AllocsPerRun(100, func() { r.Write(p) }); n != 0 {
		t.Fatalf("Write allocated %v times per call", n)
	}
}

// Changed makes a channel only when asked, and every channel it hands out
// is closed by the first write after: a waiter that took it before reading
// never misses a write, and one taken after a write waits for the next.
func TestRingChangedIsClosedByTheNextWriteOnly(t *testing.T) {
	r := NewRing(8)
	r.Write([]byte("a"))
	if r.changed != nil {
		t.Fatal("a write with nobody waiting made a channel")
	}
	a, b := r.Changed(), r.Changed()
	if a != b {
		t.Fatal("two waiters between writes must share one channel")
	}
	r.Write([]byte("b"))
	if !closed(a) {
		t.Fatal("the write did not close the channel handed out before it")
	}
	c := r.Changed()
	if closed(c) {
		t.Fatal("a channel taken after the write is already closed")
	}
	r.Restore(nil, []byte("held"), 4)
	if !closed(c) {
		t.Fatal("a restore must wake the waiters too")
	}
}

func closed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// Readers replaying while a writer floods the ring see every byte exactly
// once and in order, or a snapshot that is itself exact; none waits forever.
// Run under -race this is also the ring's locking check.
func TestRingConcurrentReplayIsExact(t *testing.T) {
	const total = 200_000
	r := NewRing(4 << 10)
	pattern := func(off uint64) byte { return byte('a' + off%26) }
	var wg sync.WaitGroup
	for reader := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			pos := uint64(0)
			for pos < total {
				changed := r.Changed()
				data, ok := r.Since(pos)
				if !ok {
					snap, at := r.SnapshotAt()
					for i, c := range snap {
						if want := pattern(at - uint64(len(snap)) + uint64(i)); c != want {
							t.Errorf("reader %d: snapshot byte %d = %q, want %q", reader, i, c, want)
							return
						}
					}
					pos = at
				} else {
					for i, c := range data {
						if want := pattern(pos + uint64(i)); c != want {
							t.Errorf("reader %d: byte at %d = %q, want %q", reader, pos+uint64(i), c, want)
							return
						}
					}
					pos += uint64(len(data))
				}
				if pos >= total {
					return
				}
				select {
				case <-changed:
				case <-time.After(5 * time.Second):
					t.Errorf("reader %d stuck at %d of %d: a wake was missed", reader, pos, total)
					return
				}
			}
		}()
	}
	rng := rand.New(rand.NewPCG(1, 2))
	for off := uint64(0); off < total; {
		n := min(uint64(1+rng.IntN(3000)), total-off)
		p := make([]byte, n)
		for i := range p {
			p[i] = pattern(off + uint64(i))
		}
		r.Write(p)
		off += n
	}
	wg.Wait()
}
