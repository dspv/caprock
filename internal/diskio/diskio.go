// Package diskio says which of the daemon's work read its disk.
//
// The footprint's disk reads are one counter for the whole process
// (procstat.SelfDiskIO): the doctor could say the daemon read 4 GB in an hour
// but not what read it, and the slow-query log names only the statements
// that took long, which was not where most of it went (the owner's daemon,
// 2026-11-21). This package splits that counter by source.
//
// The split is by what was running when the bytes were read. Every
// statement the store runs, and every read the transcript tailers and the
// other file readers make, is an operation with a source name; at each
// operation's start and end the process counter is read once, and what it
// moved since the last reading goes to the operations in flight in that
// interval, in equal shares — to "unattributed" when none was. The shares
// add up to the process counter, so nothing is invented and nothing is lost,
// but two sources running at once split what either of them read: a source
// is exact when it runs alone and an even split of an overlap otherwise.
// Reads made by code with no operation around it while another operation
// runs land on that operation, which is why the list carries
// "unattributed": when it is large, something that reads is not counted.
// What was read while nothing ran but the process took page faults that
// read is "paging (no read running)" instead (Paging): the system reading
// the daemon's own evicted pages back, which no code of ours asked for.
//
// File readers also count the bytes they asked for (logical): a re-read of a
// file the OS still holds costs the disk nothing, so a source with high
// logical and low disk bytes is re-reading, not hurting yet.
//
// The cost is one counter read (a single system call) and a mutex per
// operation boundary; nothing is written anywhere.
package diskio

import (
	"io"
	"os"
	"sort"
	"sync"

	"github.com/dspv/caprock/internal/procstat"
)

// Unattributed is the source of reads made while no operation was running
// and the process took no page fault that read.
const Unattributed = "unattributed"

// Paging is the source of reads made while no operation was running and
// the process took page faults that had to read: the system bringing back
// pages of the daemon's own program and memory it had evicted, which no
// code asks for and so no operation can name. It is large on a machine short
// of memory. Only where the system counts such faults (macOS ri_pageins,
// Linux ru_majflt); elsewhere those reads stay Unattributed.
const Paging = "paging (no read running)"

// maxSources bounds the table: past it new names are counted as "other".
const maxSources = 512

// Source is one source's running totals since the process started.
type Source struct {
	Name string `json:"source"`
	// ReadBytes is the share of the process's storage reads made while this
	// source's operations ran.
	ReadBytes uint64 `json:"read_bytes"`
	// LogicalBytes is what a file reader asked for, page cache hits
	// included; 0 for a source that is not a file reader.
	LogicalBytes uint64 `json:"logical_bytes,omitempty"`
	// Ops is how many operations ran.
	Ops uint64 `json:"ops"`
}

type meter struct {
	mu sync.Mutex
	// counter is the process's bytes read and the page faults it has taken
	// that read, both since it started.
	counter    func() (read, faults uint64)
	last       uint64
	lastFaults uint64
	started    bool
	inflight   map[string]int
	n          int
	totals     map[string]*Source
}

func newMeter(counter func() (read, faults uint64)) *meter {
	return &meter{counter: counter, inflight: map[string]int{}, totals: map[string]*Source{}}
}

var std = newMeter(procstat.SelfReads)

func (m *meter) source(name string) *Source {
	s := m.totals[name]
	if s == nil {
		if len(m.totals) >= maxSources {
			name = "other"
			if s = m.totals[name]; s != nil {
				return s
			}
		}
		s = &Source{Name: name}
		m.totals[name] = s
	}
	return s
}

// settle hands what the counter moved since the last reading to the
// operations in flight. Called with mu held.
func (m *meter) settle() {
	now, faults := m.counter()
	if !m.started {
		m.last, m.lastFaults, m.started = now, faults, true
		return
	}
	paged := faults > m.lastFaults
	m.lastFaults = max(m.lastFaults, faults)
	if now <= m.last {
		return
	}
	d := now - m.last
	m.last = now
	if m.n == 0 {
		// Nothing counted was running. When the process took faults that
		// read meanwhile, the reads are the system paging it back in (the
		// whole interval's: inside one interval a fault's read and a read
		// nothing counts cannot be told apart).
		if paged {
			m.source(Paging).ReadBytes += d
		} else {
			m.source(Unattributed).ReadBytes += d
		}
		return
	}
	share, rest := d/uint64(m.n), d%uint64(m.n)
	for name, k := range m.inflight {
		add := share * uint64(k)
		if rest > 0 { // the remainder goes to the first ones, a byte each
			r := min(rest, uint64(k))
			add += r
			rest -= r
		}
		m.source(name).ReadBytes += add
	}
}

func (m *meter) begin(name string) {
	m.mu.Lock()
	m.settle()
	m.inflight[name]++
	m.n++
	m.source(name).Ops++
	m.mu.Unlock()
}

func (m *meter) end(name string, logical int64) {
	m.mu.Lock()
	m.settle()
	if k := m.inflight[name]; k > 1 {
		m.inflight[name] = k - 1
	} else {
		delete(m.inflight, name)
	}
	m.n--
	if logical > 0 {
		m.source(name).LogicalBytes += uint64(logical)
	}
	m.mu.Unlock()
}

func (m *meter) snapshot() map[string]Source {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.settle()
	out := make(map[string]Source, len(m.totals))
	for k, s := range m.totals {
		out[k] = *s
	}
	return out
}

// Begin starts an operation of source name; the function it returns ends it
// and must be called exactly once.
func Begin(name string) (end func()) {
	std.begin(name)
	return func() { std.end(name, 0) }
}

// Snapshot is every source's totals since the process started, by name.
func Snapshot() map[string]Source { return std.snapshot() }

// Reader wraps r so that each Read is an operation of source name and the
// bytes it returns count as that source's logical bytes.
func Reader(name string, r io.Reader) io.Reader { return &reader{r: r, name: name} }

type reader struct {
	r    io.Reader
	name string
}

func (c *reader) Read(p []byte) (int, error) {
	std.begin(c.name)
	n, err := c.r.Read(p)
	std.end(c.name, int64(n))
	return n, err
}

// File is an open file whose reads are operations of one source.
type File struct {
	*os.File
	name string
}

// Open is os.Open with every read of the file an operation of source name.
func Open(name, path string) (*File, error) {
	f, err := os.Open(path) //nolint:gosec // the callers' own paths, as with os.Open
	if err != nil {
		return nil, err
	}
	return &File{File: f, name: name}, nil
}

func (f *File) Read(p []byte) (int, error) {
	std.begin(f.name)
	n, err := f.File.Read(p)
	std.end(f.name, int64(n))
	return n, err
}

// ReadAt is counted as Read is.
func (f *File) ReadAt(p []byte, off int64) (int, error) {
	std.begin(f.name)
	n, err := f.File.ReadAt(p, off)
	std.end(f.name, int64(n))
	return n, err
}

// WriteTo goes through Read, so io.Copy from a File is counted: the
// *os.File one it would otherwise promote copies without calling Read.
func (f *File) WriteTo(w io.Writer) (int64, error) {
	return io.Copy(w, readerOnly{f})
}

type readerOnly struct{ f *File }

func (r readerOnly) Read(p []byte) (int, error) { return r.f.Read(p) }

// ReadFile is os.ReadFile as one operation of source name.
func ReadFile(name, path string) ([]byte, error) {
	std.begin(name)
	b, err := os.ReadFile(path)
	std.end(name, int64(len(b)))
	return b, err
}

// Delta is one source's totals between two snapshots.
func Delta(before, after map[string]Source) []Source {
	out := make([]Source, 0, len(after))
	for k, a := range after {
		b := before[k]
		d := Source{Name: k, ReadBytes: sub(a.ReadBytes, b.ReadBytes), LogicalBytes: sub(a.LogicalBytes, b.LogicalBytes), Ops: sub(a.Ops, b.Ops)}
		if d.ReadBytes == 0 && d.LogicalBytes == 0 {
			continue
		}
		out = append(out, d)
	}
	Sort(out)
	return out
}

// Sort orders sources by disk bytes, then logical bytes, then name.
func Sort(s []Source) {
	sort.Slice(s, func(i, j int) bool {
		if s[i].ReadBytes != s[j].ReadBytes {
			return s[i].ReadBytes > s[j].ReadBytes
		}
		if s[i].LogicalBytes != s[j].LogicalBytes {
			return s[i].LogicalBytes > s[j].LogicalBytes
		}
		return s[i].Name < s[j].Name
	})
}

func sub(x, y uint64) uint64 {
	if x < y {
		return 0
	}
	return x - y
}
