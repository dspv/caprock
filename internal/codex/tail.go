package codex

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"hash/fnv"
	"io"
	"os"
)

// A live Codex session appends to its rollout for as long as it runs, and the
// importer used to answer every append by parsing the whole file again and
// offering every record in it to the store, where all but the new ones were
// rejected as duplicates. Measured 2026-10-18 on a synthetic 16,384-record
// transcript: about 200 MB allocated and some 1.2 million allocations per
// poll to import one appended line (docs/resource-usage-audit-2026-10-18.md,
// F3). A tail keeps the parser between polls instead, reads only the bytes
// after the last complete line, and the importer stores only what those
// bytes added.
//
// The checkpoint lives in memory. A restart replays a file once on its next
// change — the importer has always done that — and is incremental after it.

// tailWindow is how many bytes at each end of what has been read are
// fingerprinted, to notice a file rewritten rather than appended to.
const tailWindow = 4 << 10

// tail is one plain rollout read up to a line boundary.
type tail struct {
	path string
	p    *parser
	// off is how many bytes of the file the parser has been fed: always the
	// end of a line, or of a final line still missing its newline (open).
	off int64
	// open is set when the last line fed had no newline yet. It was complete
	// JSON, as Parse would have read it at the end of the file; the newline
	// that ends it is skipped when it arrives.
	open bool
	// stopped is set once a line longer than maxLine was met. Parse reads
	// nothing after such a line, and neither does a tail.
	stopped bool
	// id, head and edge identify what has been read: the file itself, and a
	// hash of its first and of its last tailWindow bytes before off. A file
	// replaced, truncated or rewritten in place fails one of them and is
	// read again from the start.
	id         os.FileInfo
	head, edge uint64

	// fresh is set while nothing this parser read has been stored: the next
	// import must offer every record, as a full read does.
	fresh bool
	// done is how far the last successful import got in each list, and
	// linked how many calls it stored already knowing their turn. Everything
	// after them is offered on the next import.
	done   marks
	linked int64
	// stored describes the session the last import stored under. A change
	// in any of it changes keys, the session or prices, so the file is read
	// again from the start and imported in full.
	stored identity
}

// identity is what an import's keys and prices depend on.
type identity struct {
	id, thread, model  string
	subagent, imported bool
}

func identityOf(s *Session) identity {
	return identity{id: s.ID, thread: s.ThreadID, model: s.Model, subagent: s.Subagent, imported: s.Imported}
}

func newTail(path string) *tail {
	return &tail{path: path, p: newParser(path), fresh: true}
}

// reset forgets everything read: the next advance starts at byte 0.
func (t *tail) reset() {
	*t = *newTail(t.path)
}

// readCounts is what one advance read.
type readCounts struct {
	bytes   int64
	records int64
}

// advance feeds the parser every complete line appended since the last call.
// A file that is no longer the one read so far — another file at the path,
// shorter than what was read, or different in what was read — is read again
// from the start, and the tail is fresh.
func (t *tail) advance() (rc readCounts, err error) {
	f, err := os.Open(t.path)
	if err != nil {
		return rc, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return rc, err
	}
	if t.off > 0 && !t.same(f, fi, &rc) {
		t.reset()
	}
	if t.off == 0 {
		t.id = fi
	}
	before := t.p.decoded
	defer func() { rc.records = t.p.decoded - before }()
	if t.stopped || fi.Size() <= t.off {
		return rc, nil
	}
	if t.open {
		// The line fed last had no newline. Only its newline may follow;
		// anything else means it was not complete after all, and only a
		// read from the start can say what that line really was.
		var b [2]byte
		n, _ := f.ReadAt(b[:], t.off)
		rc.bytes += int64(n)
		switch {
		case n >= 1 && b[0] == '\n':
			t.off++
		case n == 2 && b[0] == '\r' && b[1] == '\n':
			t.off += 2
		case n == 1 && b[0] == '\r':
			return rc, nil // the newline is still to come
		default:
			t.reset()
			t.id = fi
		}
		t.open = false
	}
	start := t.off
	if _, err = f.Seek(t.off, io.SeekStart); err != nil {
		return rc, err
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 16<<10), maxLine)
	sc.Split(scanLine)
	for sc.Scan() {
		tok := sc.Bytes()
		if tok[len(tok)-1] != '\n' {
			// The last line, with no newline yet. Parse reads it as a line
			// when it is complete JSON, so a tail does too; a partial write
			// is left for the next read.
			line := dropCR(tok)
			if !json.Valid(line) {
				break
			}
			t.p.feed(line)
			t.off += int64(len(tok))
			rc.bytes += int64(len(tok))
			t.open = true
			break
		}
		t.p.feed(dropCR(tok[:len(tok)-1]))
		t.off += int64(len(tok))
		rc.bytes += int64(len(tok))
	}
	if serr := sc.Err(); serr != nil {
		if !errors.Is(serr, bufio.ErrTooLong) {
			return rc, serr
		}
		// As Parse: the oversized line and everything after it are not read.
		t.stopped = true
	}
	if start < tailWindow {
		// The first tailWindow bytes are fixed once read in full.
		t.head = hashAt(f, 0, min(t.off, tailWindow), &rc)
	}
	t.edge = hashAt(f, max(0, t.off-tailWindow), t.off, &rc)
	return rc, nil
}

// same reports whether f is still the file read so far.
func (t *tail) same(f *os.File, fi os.FileInfo, rc *readCounts) bool {
	if t.id == nil || !os.SameFile(t.id, fi) || fi.Size() < t.off {
		return false
	}
	head, edge := t.fingerprint(f, rc)
	return head == t.head && edge == t.edge
}

// fingerprint hashes the first and the last tailWindow bytes before off.
func (t *tail) fingerprint(f *os.File, rc *readCounts) (uint64, uint64) {
	return hashAt(f, 0, min(t.off, tailWindow), rc), hashAt(f, max(0, t.off-tailWindow), t.off, rc)
}

func hashAt(f *os.File, from, to int64, rc *readCounts) uint64 {
	h := fnv.New64a()
	if to > from {
		n, _ := io.Copy(h, io.NewSectionReader(f, from, to-from))
		rc.bytes += n
	}
	return h.Sum64()
}

// scanLine splits like bufio.ScanLines but keeps each line's newline, so the
// bytes consumed are known exactly, and returns a final line with none.
func scanLine(data []byte, atEOF bool) (int, []byte, error) {
	if i := bytes.IndexByte(data, '\n'); i >= 0 {
		return i + 1, data[:i+1], nil
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

// dropCR drops a terminal \r, as bufio.ScanLines does.
func dropCR(b []byte) []byte {
	if len(b) > 0 && b[len(b)-1] == '\r' {
		return b[:len(b)-1]
	}
	return b
}

// commit records that an import stored everything read so far, and drops
// what no later record can need.
func (t *tail) commit(s *Session) {
	t.done = t.p.totals()
	t.linked = t.p.linkFrom
	t.fresh = false
	t.stored = identityOf(s)
	t.p.trim(t.done)
}

// pending is the session to import now: s (a header() of this tail's parser,
// already linked) with every item a full read would store that the last
// import did not. That is every item after done, plus two kinds already
// stored that a full read would offer to some effect: a turn whose prose
// grew since (store.MergeAssistantText; syncText then sets it), and a call
// stored before its turn was known (store.LinkToolCall).
func (t *tail) pending(s *Session) {
	if t.fresh {
		t.p.fill(s, marks{})
		return
	}
	from := t.done
	from.tools = t.linked
	for _, i := range t.p.grown {
		from.turns = min(from.turns, i)
	}
	t.p.fill(s, from)
}
