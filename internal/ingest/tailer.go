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
	for ctx.Err() == nil {
		line, err := reader.ReadBytes('\n')
		if err == nil {
			consumed += int64(len(line))
			t.handleLine(ctx, f, line, fi.ModTime())
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
	if batch > 0 || consumed > 0 {
		_ = store.SetOffset(ctx, t.Store.DB(), f.path, f.sessionID, f.offset)
	}
}

func (t *Tailer) handleLine(ctx context.Context, f *fileState, raw []byte, fallbackTs time.Time) {
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
		return
	}
	if f.sessionID == "" {
		f.sessionID = l.SessionID
	}
	info := rollup.SessionInfo{Cwd: l.Cwd, TranscriptPath: f.path, GitBranch: l.GitBranch, Version: l.Version}
	if l.Message != nil {
		info.Model = l.Message.Model
	}
	for _, ev := range l.Events(fallbackTs) {
		ev := ev
		res, err := t.Recorder.Record(ctx, &ev, info)
		if err != nil {
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
