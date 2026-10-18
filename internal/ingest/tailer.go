package ingest

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// DefaultRoot returns ~/.claude/projects.
func DefaultRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "projects"), nil
}

// Stats counts what the tailer has done (exposed on /v1/status).
type Stats struct {
	FilesKnown     int   `json:"files_known"`
	LinesParsed    int64 `json:"lines_parsed"`
	LinesMalformed int64 `json:"lines_malformed"`
	LinesSkipped   int64 `json:"lines_skipped"`
	EventsStored   int64 `json:"events_stored"`
	EventsDeduped  int64 `json:"events_deduped"`
	BackfillDone   bool  `json:"backfill_done"`
}

// Tailer follows every *.jsonl under Root and records normalized events.
type Tailer struct {
	Root     string
	Recorder *rollup.Recorder
	Store    *store.Store
	Log      *slog.Logger
	// PollInterval is the fallback rescan cadence (fsnotify is best-effort and not
	// recursive; new project directories and network filesystems need the poll).
	PollInterval time.Duration
	// BackfillWindow: files last modified longer ago than this are backfilled in
	// the background after live files; zero means everything is treated as live.
	BackfillWindow time.Duration
	// MaxLine bounds one JSONL record: the bytes before its newline. A longer
	// record is skipped without being held in memory (see readFile). The longest
	// line in 4.0 GB of local transcripts was 2.1 MB (2026-10-18); a
	// tool_result can embed a whole file, hence the headroom.
	MaxLine int

	mu    sync.Mutex
	files map[string]*fileState
	stats Stats
	// dirty holds the files fsnotify reported written since the last wake;
	// a wake reads those and nothing else (see Run).
	dirty map[string]struct{}
	// wake is signalled by fsnotify to trigger an immediate pass.
	wake chan struct{}
	// watching is set once fsnotify is running: the poll can then be
	// narrowed to recently written files.
	watching bool
}

// hotWindow is how recently a transcript must have changed for the 2-second
// poll to look at it while fsnotify is running. Every file is still stat'ed by
// the full pass that follows each 30-second rescan.
//
// The poll used to stat every transcript the machine had ever written, and
// so did every fsnotify wake — one per line a session wrote. With 1,264
// transcripts and a few busy sessions that was tens of thousands of stat
// calls a second, the largest single cost in an otherwise idle daemon
// (2026-10-10, the owner's machine). fsnotify names the file it saw written,
// so a wake reads that file; the poll is the fallback for a missed event.
const hotWindow = 10 * time.Minute

type fileState struct {
	mu        sync.Mutex // serializes readFile between the live loop and backfill
	path      string
	offset    int64
	sessionID string
	lastSize  int64
	lastMod   time.Time
	// skipTo is set while the record starting at offset is longer than
	// MaxLine and has no newline yet: the position its bytes have been read
	// (and dropped) up to. The next read resumes there instead of reading the
	// record again, and offset stays on the record's first byte, a boundary,
	// until its newline arrives. Zero means no record is being skipped.
	skipTo int64
	// mtime-based ordering for backfill
	backfilled bool
}

// New creates a tailer with defaults.
func New(root string, rec *rollup.Recorder, st *store.Store, log *slog.Logger) *Tailer {
	if log == nil {
		log = slog.Default()
	}
	return &Tailer{
		Root: root, Recorder: rec, Store: st, Log: log,
		PollInterval: 2 * time.Second, BackfillWindow: 24 * time.Hour, MaxLine: 16 << 20,
		files: map[string]*fileState{}, dirty: map[string]struct{}{}, wake: make(chan struct{}, 1),
	}
}

// Stats returns a snapshot of counters.
func (t *Tailer) Stats() Stats {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.stats
	s.FilesKnown = len(t.files)
	return s
}

// Run tails until ctx is cancelled. It first processes live files (modified
// within BackfillWindow), then backfills older history in the background while
// continuing to follow live files.
func (t *Tailer) Run(ctx context.Context) error {
	if err := os.MkdirAll(t.Root, 0o700); err != nil {
		return err
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Log.Warn("fsnotify unavailable; polling only", "component", "ingest", "err", err)
	} else {
		defer watcher.Close()
		t.mu.Lock()
		t.watching = true
		t.mu.Unlock()
		go t.watchLoop(ctx, watcher)
	}
	if err := t.discover(watcher); err != nil {
		return err
	}
	// Live pass first so the dashboard is useful immediately.
	t.pass(ctx, true)
	// Backfill older transcripts in the background, oldest last.
	go t.backfill(ctx)

	ticker := time.NewTicker(t.PollInterval)
	defer ticker.Stop()
	rescan := time.NewTicker(30 * time.Second)
	defer rescan.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.wake:
			t.passDirty(ctx)
		case <-ticker.C:
			t.passHot(ctx)
		case <-rescan.C:
			if err := t.discover(watcher); err != nil {
				t.Log.Warn("rescan failed", "component", "ingest", "err", err)
			}
			t.pass(ctx, true)
		}
	}
}

// discover walks Root for *.jsonl files and directories to watch.
func (t *Tailer) discover(w *fsnotify.Watcher) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return filepath.WalkDir(t.Root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // unreadable subtree: skip, never fail the whole scan
		}
		if d.IsDir() {
			if w != nil {
				_ = w.Add(path) // idempotent; errors (too many watches) are tolerated
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		if _, ok := t.files[path]; !ok {
			t.files[path] = &fileState{path: path}
		}
		return nil
	})
}

func (t *Tailer) watchLoop(ctx context.Context, w *fsnotify.Watcher) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-w.Events:
			if !ok {
				return
			}
			if ev.Has(fsnotify.Create) {
				if fi, err := os.Stat(ev.Name); err == nil && fi.IsDir() {
					_ = w.Add(ev.Name)
					// A new project dir may already contain a transcript.
					_ = t.discover(w)
				}
			}
			if strings.HasSuffix(ev.Name, ".jsonl") && ev.Has(fsnotify.Create|fsnotify.Write) {
				t.mu.Lock()
				if _, ok := t.files[ev.Name]; !ok {
					t.files[ev.Name] = &fileState{path: ev.Name}
				}
				t.dirty[ev.Name] = struct{}{}
				t.mu.Unlock()
				select {
				case t.wake <- struct{}{}:
				default:
				}
			}
		case _, ok := <-w.Errors:
			if !ok {
				return
			}
		}
	}
}

// pass reads new bytes from every known file. liveOnly restricts to files
// modified within BackfillWindow or already backfilled.
func (t *Tailer) pass(ctx context.Context, liveOnly bool) {
	t.mu.Lock()
	paths := make([]*fileState, 0, len(t.files))
	for _, f := range t.files {
		paths = append(paths, f)
	}
	t.mu.Unlock()
	t.read(ctx, paths, liveOnly)
}

// passDirty reads the files fsnotify reported written since the last wake.
func (t *Tailer) passDirty(ctx context.Context) {
	t.mu.Lock()
	paths := make([]*fileState, 0, len(t.dirty))
	for p := range t.dirty {
		if f := t.files[p]; f != nil {
			paths = append(paths, f)
		}
	}
	clear(t.dirty)
	t.mu.Unlock()
	t.read(ctx, paths, true)
}

// passHot is the poll: every file while fsnotify is unavailable, otherwise
// the files written within hotWindow and any whose last read stalled.
func (t *Tailer) passHot(ctx context.Context) {
	t.mu.Lock()
	if !t.watching {
		t.mu.Unlock()
		t.pass(ctx, true)
		return
	}
	all := make([]*fileState, 0, len(t.files))
	for _, f := range t.files {
		all = append(all, f)
	}
	t.mu.Unlock()
	// f.mu is taken with t.mu released: readFile holds f.mu and takes t.mu.
	since := time.Now().Add(-hotWindow)
	paths := all[:0]
	for _, f := range all {
		f.mu.Lock()
		hot := f.lastSize < 0 || f.lastMod.After(since)
		f.mu.Unlock()
		if hot {
			paths = append(paths, f)
		}
	}
	t.read(ctx, paths, true)
}

// read stats each file and reads the ones that changed.
func (t *Tailer) read(ctx context.Context, paths []*fileState, liveOnly bool) {
	cutoff := time.Now().Add(-t.BackfillWindow)
	for _, f := range paths {
		if ctx.Err() != nil {
			return
		}
		fi, err := os.Stat(f.path)
		if err != nil {
			continue
		}
		f.mu.Lock()
		skip := (liveOnly && t.BackfillWindow > 0 && !f.backfilled && fi.ModTime().Before(cutoff)) ||
			(fi.Size() == f.lastSize && fi.ModTime().Equal(f.lastMod) && f.offset > 0)
		f.mu.Unlock()
		if skip {
			continue
		}
		t.readFile(ctx, f, fi)
	}
}

// backfill processes files older than the window, newest first, at a gentle pace.
func (t *Tailer) backfill(ctx context.Context) {
	t.mu.Lock()
	var old []*fileState
	cutoff := time.Now().Add(-t.BackfillWindow)
	for _, f := range t.files {
		if fi, err := os.Stat(f.path); err == nil && fi.ModTime().Before(cutoff) {
			f.mu.Lock()
			f.lastMod = fi.ModTime()
			f.mu.Unlock()
			old = append(old, f)
		}
	}
	t.mu.Unlock()
	sort.Slice(old, func(i, j int) bool { return old[i].lastMod.After(old[j].lastMod) })
	for _, f := range old {
		if ctx.Err() != nil {
			return
		}
		fi, err := os.Stat(f.path)
		if err != nil {
			continue
		}
		f.mu.Lock()
		f.lastMod = time.Time{} // force read
		f.mu.Unlock()
		t.readFile(ctx, f, fi)
		f.mu.Lock()
		f.backfilled = true
		f.mu.Unlock()
	}
	t.mu.Lock()
	t.stats.BackfillDone = true
	t.mu.Unlock()
	t.Log.Info("transcript backfill complete", "component", "ingest", "files", len(old))
}

// readFile reads from the stored offset to EOF, recording complete lines.
//
// A record is held in memory only up to MaxLine bytes. A longer one, complete
// or still being written, is read in fragments of the reader's buffer and
// dropped as it goes, counted as malformed and logged once, and reading carries
// on after its newline. Reading it whole first, as ReadBytes did, allocated
// twice the record's size per read (67 MB for a 32 MiB record, measured
// 2026-10-18) and did it again on every pass while the record had no newline.
func (t *Tailer) readFile(ctx context.Context, f *fileState, fi os.FileInfo) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.offset == 0 && f.lastSize == 0 {
		// First sight of this file in this process: resume from the persisted offset.
		if off, err := store.GetOffset(ctx, t.Store.DB(), f.path); err == nil {
			f.offset = off
		}
	}
	if fi.Size() < f.offset || fi.Size() < f.skipTo {
		// Truncated/rotated: start over. Duplicates are absorbed by keyed dedupe.
		// A file shorter than what was read of a record being skipped was cut
		// too, even when it still reaches the offset.
		f.offset = 0
		f.skipTo = 0
	}
	fh, err := os.Open(f.path)
	if err != nil {
		return
	}
	defer fh.Close()
	// A shorter file is not the only way a transcript is replaced.
	//
	// Claude Code rewrites a transcript in place — on a resume, on a compact —
	// and the replacement is often the same length or longer. Then the size
	// check above does not fire, we seek into the middle of *different*
	// content, and every line before that offset is never read. Not a
	// duplicate-detection problem: those lines are never parsed, so the dedupe
	// key never sees them. A session simply arrives missing its first turns,
	// with nothing anywhere saying so.
	//
	// The cheap test is the byte before the offset: every record this tailer
	// consumes ends in a newline, so if that byte is not one, the file under us
	// is not the file we measured. Costs one read of one byte per sweep.
	if f.offset > 0 && !endsLineAt(fh, f.offset) {
		f.offset = 0
		f.skipTo = 0
	}
	pos := f.offset // where the reader is in the file
	if f.skipTo > 0 {
		pos = f.skipTo
	}
	if _, err := fh.Seek(pos, io.SeekStart); err != nil {
		return
	}
	reader := bufio.NewReaderSize(fh, 256<<10)
	// The lines are written in batches (rollup.Batch), each committed with
	// the offset it reaches, in one transaction: the offset in the database
	// never runs ahead of the events, and a batch that fails to commit leaves
	// it on the last batch that did (F7 in the resource audit).
	b := t.Recorder.Batch(ctx)
	defer b.Abort()
	durable := f.offset // the offset the database holds
	openAt := f.offset  // where the line that opened the batch begins
	commit := func() bool {
		wrote := b.Open()
		if f.offset == durable && !wrote {
			return true
		}
		// Only a record boundary is persisted, never skipTo: after a restart
		// an oversized record is read from its start and skipped again.
		off := f.offset
		err := b.Exec(func(ctx context.Context, q store.Querier) error {
			return store.SetOffset(ctx, q, f.path, f.sessionID, off)
		})
		var stored, deduped int
		if err == nil {
			stored, deduped, err = b.Flush()
		}
		if err != nil {
			b.Abort()
			t.Log.Warn("commit transcript batch; will read it again", "component", "ingest", "err", err, "path", f.path)
			if wrote {
				// The batch's events were rolled back: read them again. Lines
				// that wrote nothing (an oversized record) stay read.
				f.offset = openAt
			}
			return false
		}
		durable = off
		t.mu.Lock()
		t.stats.EventsStored += int64(stored)
		t.stats.EventsDeduped += int64(deduped)
		t.mu.Unlock()
		return true
	}
	stalled := false
	if f.skipTo > 0 {
		// Go on dropping the oversized record an earlier read stopped inside.
		n, done := skipRecord(ctx, reader)
		pos += n
		if done {
			f.offset, f.skipTo = pos, 0
		} else {
			f.skipTo = pos
		}
	}
	for f.skipTo == 0 && ctx.Err() == nil {
		line, n, over, err := readRecord(ctx, reader, t.MaxLine)
		if over {
			t.mu.Lock()
			t.stats.LinesMalformed++
			t.mu.Unlock()
			t.Log.Warn("transcript record over the size limit skipped", "component", "ingest",
				"path", f.path, "offset", f.offset, "limit", t.MaxLine)
			pos += n
			if err == nil {
				f.offset = pos // its newline was read: carry on after it
				continue
			}
			f.skipTo = pos // no newline yet: the next read resumes here
			break
		}
		if err != nil {
			// An incomplete trailing line within MaxLine (writer mid-flush), or a
			// read error: leave the offset before it so the next pass reads it whole.
			break
		}
		if !b.Open() {
			openAt = f.offset
		}
		if !t.handleLine(ctx, b, f, line, fi.ModTime()) {
			// The line could not be written and is worth trying again: stop
			// BEFORE it, so the offset stays on it and the next pass reads
			// it once more. Moving past it was how SQLITE_BUSY turned into
			// lost turns — the warning was logged and the line was never
			// read again. Whatever part of the line did get stored is
			// absorbed by keyed dedupe on the retry.
			stalled = true
			break
		}
		pos += n
		f.offset = pos
		if b.Due() && !commit() {
			stalled = true
			break
		}
	}
	if !commit() {
		stalled = true
	}
	f.lastSize, f.lastMod = fi.Size(), fi.ModTime()
	if stalled || ctx.Err() != nil {
		// Forget the size and time we read up to, or the next pass would see
		// an unchanged file and skip it — leaving the retry waiting on the
		// session writing another line, which an ended session never does.
		// A cancelled read did not reach the end either.
		f.lastSize, f.lastMod = -1, time.Time{}
	}
}

// readRecord reads one record of at most limit bytes before its newline. It
// returns the record, newline included, in a slice of its own; the number of
// bytes read; and err == nil when the newline was found.
//
// A record longer than limit is not kept: over is true, line is nil, and the
// reader has gone past the record's newline (err == nil) or to the end of what
// is there (err != nil), dropping bytes as it went, so the memory a record
// takes stays within limit plus one reader buffer however long it is.
func readRecord(ctx context.Context, r *bufio.Reader, limit int) (line []byte, n int64, over bool, err error) {
	var full [][]byte // copies of the buffer-sized fragments before the last
	size := 0
	for {
		frag, err := r.ReadSlice('\n')
		n += int64(len(frag))
		body := len(frag)
		if err == nil {
			body-- // the newline is not counted in the record's length
		}
		if size+body > limit {
			if err == nil {
				return nil, n, true, nil
			}
			if !errors.Is(err, bufio.ErrBufferFull) {
				return nil, n, true, err
			}
			m, done := skipRecord(ctx, r)
			n += m
			if done {
				return nil, n, true, nil
			}
			return nil, n, true, io.EOF
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			full = append(full, bytes.Clone(frag))
			size += len(frag)
			continue
		}
		// The newline, the end of the file, or a read error: hand back what
		// there is as one slice, as ReadBytes did.
		buf := make([]byte, size+len(frag))
		at := 0
		for _, b := range full {
			at += copy(buf[at:], b)
		}
		copy(buf[at:], frag)
		return buf, n, false, err
	}
}

// skipRecord drops bytes up to and including the next newline. It returns how
// many it read and whether the newline was among them; false means the end of
// the file, a read error or cancellation came first. Nothing is allocated:
// each fragment is the reader's own buffer.
func skipRecord(ctx context.Context, r *bufio.Reader) (n int64, done bool) {
	for ctx.Err() == nil {
		frag, err := r.ReadSlice('\n')
		n += int64(len(frag))
		if err == nil {
			return n, true
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return n, false
		}
	}
	return n, false
}

// handleLine records one transcript line. It returns false when a write
// failed in a way that should be retried — the database was busy, or the
// daemon is shutting down — and the caller must not move past the line.
// Any other failure is logged and the line is consumed: an event the store
// rejects for what it is would be rejected again on every pass.
func (t *Tailer) handleLine(ctx context.Context, b *rollup.Batch, f *fileState, raw []byte, fallbackTs time.Time) bool {
	l, err := ParseLine(bytes.TrimRight(raw, "\r\n"))
	t.mu.Lock()
	t.stats.LinesParsed++
	t.mu.Unlock()
	if err != nil {
		t.mu.Lock()
		if errors.Is(err, ErrMalformed) {
			t.stats.LinesMalformed++
		} else {
			t.stats.LinesSkipped++
		}
		t.mu.Unlock()
		return true
	}
	if l.Type == TypeAITitle {
		if err := b.Exec(func(ctx context.Context, q store.Querier) error {
			return store.SetTitle(ctx, q, l.SessionID, l.AITitle)
		}); err != nil {
			if retryable(ctx, err) {
				return false
			}
			t.Log.Warn("record session title", "component", "ingest", "err", err, "path", f.path)
		}
		return true
	}
	if f.sessionID == "" {
		f.sessionID = l.SessionID
	}
	info := rollup.SessionInfo{Cwd: l.Cwd, TranscriptPath: f.path, GitBranch: lineBranch(l, fallbackTs, time.Now()), Version: l.Version}
	if l.Message != nil {
		info.Model = l.Message.Model
	}
	for _, ev := range l.Events(fallbackTs) {
		ev := ev
		_, err := b.Record(ctx, &ev, info)
		if err != nil {
			if retryable(ctx, err) {
				t.Log.Warn("record transcript event; will retry the line", "component", "ingest", "err", err, "path", f.path)
				return false
			}
			t.Log.Warn("record transcript event", "component", "ingest", "err", err, "path", f.path)
		}
	}
	return true
}

// retryable reports whether a failed write should be tried again later rather
// than given up on: the database was locked by another writer, or the daemon is
// stopping and cancelled the write mid-way.
func retryable(ctx context.Context, err error) bool {
	return store.IsBusy(err) || ctx.Err() != nil
}

// endsLineAt reports whether the byte at off-1 is a newline — that is, whether
// `off` is still a record boundary in the file as it is now.
//
// A false answer means the file was replaced by content of the same size or
// larger, and the offset points into the middle of something else. Any read
// error is reported as "not a boundary": re-reading a file from the start
// costs a sweep and is absorbed by keyed dedupe, while trusting a stale offset
// costs data.
func endsLineAt(fh *os.File, off int64) bool {
	var b [1]byte
	if _, err := fh.ReadAt(b[:], off-1); err != nil {
		return false
	}
	return b[0] == '\n'
}

// liveBranchWindow is how recent a transcript line must be for the branch of
// its cwd's checkout, as it is now, to stand for the branch it was written on.
const liveBranchWindow = 10 * time.Minute

// lineBranch is the branch a transcript line puts on its session. Claude
// Code's `gitBranch` is not the branch of the line's cwd: while a background
// agent worked in a linked worktree, the parent's own lines (no agentId, not
// a sidechain, cwd the main checkout on master) reported the worktree's
// branch, and the session's header read `caprock · feat/cockpit-scrub`. A
// line written in the last few minutes takes the branch its cwd's checkout
// has now, read from HEAD; an older line — a backfill, a session re-read —
// keeps what it says, since today's HEAD says nothing about last week's line.
func lineBranch(l *Line, fallbackTs, now time.Time) string {
	if l.Cwd == "" || l.GitBranch == "" {
		return l.GitBranch
	}
	if d := now.Sub(l.Ts(fallbackTs)); d > liveBranchWindow || d < -liveBranchWindow {
		return l.GitBranch
	}
	if b, ok := checkoutBranches.at(l.Cwd, now); ok {
		return b
	}
	return l.GitBranch
}

// branchCacheTTL is how long a folder's branch, once read, answers for it.
// A transcript arrives in bursts — dozens of lines a second while a turn
// streams — and each would otherwise stat and read HEAD again; a checkout
// switched mid-burst is picked up two seconds later.
const branchCacheTTL = 2 * time.Second

// branchCache remembers the branch read for a folder (store.BranchAt) for
// branchCacheTTL. Safe for the tailers' concurrent use.
type branchCache struct {
	mu   sync.Mutex
	read func(dir string) (string, bool)
	m    map[string]cachedBranch
}

type cachedBranch struct {
	branch string
	ok     bool
	at     time.Time
}

var checkoutBranches = &branchCache{read: store.BranchAt}

func (c *branchCache) at(dir string, now time.Time) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, hit := c.m[dir]; hit && now.Sub(e.at) < branchCacheTTL && !now.Before(e.at) {
		return e.branch, e.ok
	}
	b, ok := c.read(dir)
	if c.m == nil || len(c.m) > 256 {
		// Folders are few; a map that grew past that is cleared rather than swept.
		c.m = map[string]cachedBranch{}
	}
	c.m[dir] = cachedBranch{branch: b, ok: ok, at: now}
	return b, ok
}
