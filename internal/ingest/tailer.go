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
	// MaxLine bounds one JSONL line (a tool_result can embed a whole file).
	MaxLine int

	mu    sync.Mutex
	files map[string]*fileState
	stats Stats
	// wake is signalled by fsnotify to trigger an immediate pass.
	wake chan struct{}
}

type fileState struct {
	mu        sync.Mutex // serializes readFile between the live loop and backfill
	path      string
	offset    int64
	sessionID string
	lastSize  int64
	lastMod   time.Time
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
		files: map[string]*fileState{}, wake: make(chan struct{}, 1),
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
			t.pass(ctx, true)
		case <-ticker.C:
			t.pass(ctx, true)
		case <-rescan.C:
			if err := t.discover(watcher); err != nil {
				t.Log.Warn("rescan failed", "component", "ingest", "err", err)
			}
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
func (t *Tailer) readFile(ctx context.Context, f *fileState, fi os.FileInfo) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.offset == 0 && f.lastSize == 0 {
		// First sight of this file in this process: resume from the persisted offset.
		if off, err := store.GetOffset(ctx, t.Store.DB(), f.path); err == nil {
			f.offset = off
		}
	}
	if fi.Size() < f.offset {
		// Truncated/rotated: start over. Duplicates are absorbed by keyed dedupe.
		f.offset = 0
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
	}
	if _, err := fh.Seek(f.offset, io.SeekStart); err != nil {
		return
	}
	reader := bufio.NewReaderSize(fh, 256<<10)
	consumed := int64(0)
	batch := 0
	stalled := false
	for ctx.Err() == nil {
		line, err := reader.ReadBytes('\n')
		if err == nil {
			if !t.handleLine(ctx, f, line, fi.ModTime()) {
				// The line could not be written and is worth trying again: stop
				// BEFORE it, so the offset stays on it and the next pass reads
				// it once more. Moving past it was how SQLITE_BUSY turned into
				// lost turns — the warning was logged and the line was never
				// read again. Whatever part of the line did get stored is
				// absorbed by keyed dedupe on the retry.
				stalled = true
				break
			}
			consumed += int64(len(line))
			batch++
			continue
		}
		if errors.Is(err, io.EOF) && len(line) > 0 {
			// Incomplete trailing line (writer mid-flush): leave the offset before it
			// so the next pass re-reads it whole — unless it is absurdly long, in
			// which case skip it rather than re-read forever.
			if len(line) > t.MaxLine {
				consumed += int64(len(line))
				t.mu.Lock()
				t.stats.LinesMalformed++
				t.mu.Unlock()
			}
		}
		break
	}
	f.offset += consumed
	f.lastSize, f.lastMod = fi.Size(), fi.ModTime()
	if stalled {
		// Forget the size and time we read up to, or the next pass would see
		// an unchanged file and skip it — leaving the retry waiting on the
		// session writing another line, which an ended session never does.
		f.lastSize, f.lastMod = -1, time.Time{}
	}
	if batch > 0 || consumed > 0 {
		_ = store.SetOffset(ctx, t.Store.DB(), f.path, f.sessionID, f.offset)
	}
}

// handleLine records one transcript line. It returns false when a write
// failed in a way that should be retried — the database was busy, or the
// daemon is shutting down — and the caller must not move past the line.
// Any other failure is logged and the line is consumed: an event the store
// rejects for what it is would be rejected again on every pass.
func (t *Tailer) handleLine(ctx context.Context, f *fileState, raw []byte, fallbackTs time.Time) bool {
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
		if err := store.SetTitle(ctx, t.Store.DB(), l.SessionID, l.AITitle); err != nil {
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
		res, err := t.Recorder.Record(ctx, &ev, info)
		if err != nil {
			if retryable(ctx, err) {
				t.Log.Warn("record transcript event; will retry the line", "component", "ingest", "err", err, "path", f.path)
				return false
			}
			t.Log.Warn("record transcript event", "component", "ingest", "err", err, "path", f.path)
			continue
		}
		t.mu.Lock()
		if res.Stored {
			t.stats.EventsStored++
		} else {
			t.stats.EventsDeduped++
		}
		t.mu.Unlock()
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
	if b, ok := store.BranchAt(l.Cwd); ok {
		return b
	}
	return l.GitBranch
}
