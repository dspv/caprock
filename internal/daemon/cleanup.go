package daemon

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/store"
)

// What Caprock cleans out of its data directory, when, and why. The rules are
// in .ai/02-architecture.md § Retention and cleanup; this file is them.
//
// Everything here runs on its own: one loop checks every idleCheckEvery and
// acts only when the daemon has been idle — nothing recorded for idleFor — so
// no sweep or measurement competes with a session someone is working in. Each
// sweep that removes anything logs one INFO line saying what and how many
// bytes. Nothing is removed that exists nowhere else and is still of use:
// prose, prompts, costs and stats live in the database and are never touched
// here.
const (
	idleCheckEvery = 15 * time.Minute
	idleFor        = 30 * time.Minute
	// sweepEvery is how often the data directory is swept, at most.
	sweepEvery = 24 * time.Hour

	// pasteKeep is how long a pasted or dropped file is kept. It was handed
	// to a session by path for that session to read; a month later the
	// session has read it or never will.
	pasteKeep = 30 * 24 * time.Hour
	// chatEmptyKeep is how long an empty chat directory with no session is
	// kept: a quick chat that was opened and closed before Claude started.
	chatEmptyKeep = 24 * time.Hour
	// geminiKeep is how long a Gemini telemetry file is kept after its
	// session ended. The file is Gemini's transcript and Caprock reads it
	// into the database as it is written; once the session is over and
	// recorded, the file is only a second copy.
	geminiKeep = 30 * 24 * time.Hour
	// staleLogKeep is the age past which a log file nothing writes any more
	// is removed.
	staleLogKeep = 30 * 24 * time.Hour
)

// staleLogs are files in the data directory that no current version writes.
// launchd.log was the LaunchAgent's output before the plist moved it to
// service.log; on the owner's machine it was last written 2026-08-22.
var staleLogs = []string{"launchd.log"}

// sweepLookup is what the sweep asks the database.
type sweepLookup interface {
	// session reports whether a session is recorded, has ended, and when it
	// last recorded anything (unix ms).
	session(ctx context.Context, id string) (found, ended bool, lastEventMs int64)
	// cwdUsed reports whether any session ran in dir.
	cwdUsed(ctx context.Context, dir string) bool
}

// sweepResult is what one sweep removed.
type sweepResult struct {
	Paste, Chats, Gemini, Logs int
	Bytes                      int64
}

func (r sweepResult) removed() int { return r.Paste + r.Chats + r.Gemini + r.Logs }

// sweepAction is the footprint's line for a sweep that removed something
// (actions.go): what went, and how much it freed.
func sweepAction(r sweepResult) string {
	var what []string
	if r.Paste > 0 {
		what = append(what, plural(r.Paste, "pasted file")+" older than 30 days")
	}
	if r.Chats > 0 {
		what = append(what, plural(r.Chats, "empty chat folder"))
	}
	if r.Gemini > 0 {
		what = append(what, plural(r.Gemini, "Gemini telemetry file")+" of sessions ended over 30 days ago")
	}
	if r.Logs > 0 {
		what = append(what, plural(r.Logs, "unused log"))
	}
	return "removed " + joinAnd(what) + " (" + Bytes(uint64(max(r.Bytes, 0))) + " freed)"
}

// sweepDataDir applies the cleanup rules to dataDir as of now.
func sweepDataDir(ctx context.Context, dataDir string, now time.Time, look sweepLookup) sweepResult {
	var r sweepResult
	if dataDir == "" {
		return r
	}
	// Pasted files: paste/<stamp>-<random>/<name>, the desktop app's
	// paste/drop-<nanos>/<name>, and the flat files of older versions.
	// Judged by the newest file inside, so nothing still being written goes.
	pasteDir := config.PasteDir(dataDir)
	if entries, err := os.ReadDir(pasteDir); err == nil {
		for _, e := range entries {
			if ctx.Err() != nil {
				return r
			}
			p := filepath.Join(pasteDir, e.Name())
			newest, size := newestAndSize(p)
			if newest.IsZero() || now.Sub(newest) < pasteKeep {
				continue
			}
			if os.RemoveAll(p) == nil {
				r.Paste++
				r.Bytes += size
			}
		}
	}
	// Empty chat directories no session ever ran in. A chat a session did
	// run in is kept even when empty: resuming it starts Claude Code there.
	chatsDir := config.ChatsDir(dataDir)
	if entries, err := os.ReadDir(chatsDir); err == nil {
		for _, e := range entries {
			if ctx.Err() != nil {
				return r
			}
			if !e.IsDir() {
				continue
			}
			p := filepath.Join(chatsDir, e.Name())
			info, err := e.Info()
			if err != nil || now.Sub(info.ModTime()) < chatEmptyKeep || !emptyDir(p) || look.cwdUsed(ctx, p) {
				continue
			}
			if os.Remove(p) == nil {
				r.Chats++
			}
		}
	}
	// Gemini telemetry of sessions that ended more than geminiKeep ago. A
	// file whose session the database does not know is kept: it may not
	// have been read yet.
	gemDir := filepath.Join(dataDir, "gemini")
	if entries, err := os.ReadDir(gemDir); err == nil {
		for _, e := range entries {
			if ctx.Err() != nil {
				return r
			}
			id, ok := strings.CutSuffix(e.Name(), ".otel.log")
			if !ok || e.IsDir() {
				continue
			}
			found, ended, last := look.session(ctx, id)
			if !found || !ended || now.Sub(time.UnixMilli(last)) < geminiKeep {
				continue
			}
			p := filepath.Join(gemDir, e.Name())
			info, err := e.Info()
			if err != nil || now.Sub(info.ModTime()) < geminiKeep {
				continue
			}
			if os.Remove(p) == nil {
				r.Gemini++
				r.Bytes += info.Size()
			}
		}
	}
	for _, name := range staleLogs {
		p := filepath.Join(dataDir, name)
		info, err := os.Stat(p)
		if err != nil || !info.Mode().IsRegular() || now.Sub(info.ModTime()) < staleLogKeep {
			continue
		}
		if os.Remove(p) == nil {
			r.Logs++
			r.Bytes += info.Size()
		}
	}
	return r
}

// newestAndSize is the latest modification time and the total size of the
// regular files at or under p. A directory with no files is judged by its
// own time.
func newestAndSize(p string) (time.Time, int64) {
	var newest time.Time
	var size int64
	_ = filepath.WalkDir(p, func(_ string, de fs.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // an unreadable entry is skipped, not fatal
		}
		info, err := de.Info()
		if err != nil {
			return nil //nolint:nilerr // vanished mid-walk
		}
		if info.ModTime().After(newest) {
			newest = info.ModTime()
		}
		if info.Mode().IsRegular() {
			size += info.Size()
		}
		return nil
	})
	return newest, size
}

func emptyDir(p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	_, err = f.Readdirnames(1)
	return errors.Is(err, io.EOF)
}

// storeLookup answers sweepLookup from the database.
type storeLookup struct{ st *store.Store }

func (l storeLookup) session(ctx context.Context, id string) (bool, bool, int64) {
	s, err := store.GetSession(ctx, l.st.DB(), id)
	if err != nil {
		return false, false, 0
	}
	return true, s.Status == store.StatusEnded, s.LastEventAt
}

func (l storeLookup) cwdUsed(ctx context.Context, dir string) bool {
	used, err := store.SessionRanIn(ctx, l.st.DB(), dir)
	// Unknown is "used": a directory is never removed on a failed read.
	return err != nil || used
}

// idleDue reports whether work last done at last is due again after every,
// given the last recorded activity: only once the daemon has been idle.
func idleDue(last, activity, now time.Time, every time.Duration) bool {
	if now.Sub(activity) < idleFor {
		return false
	}
	return last.IsZero() || now.Sub(last) >= every
}

// idleLoop runs the idle-time housekeeping: the data-directory sweep, the
// daily storage measurement, and making the database smaller (compact.go).
func (d *Daemon) idleLoop(ctx context.Context) {
	t := time.NewTicker(idleCheckEvery)
	defer t.Stop()
	var swept time.Time
	var cs compactState
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		now := time.Now()
		activity := time.UnixMilli(d.activity.Load())
		if idleDue(swept, activity, now, sweepEvery) {
			swept = now
			r := sweepDataDir(ctx, d.opt.DataDir, now, storeLookup{d.store})
			if r.removed() > 0 {
				d.actions.add(sweepAction(r))
				d.log.Info("data directory swept", "component", "daemon",
					"paste", r.Paste, "empty_chats", r.Chats, "gemini_logs", r.Gemini, "stale_logs", r.Logs, "freed_bytes", r.Bytes)
			}
		}
		// Before the measurement, which reads the whole file: it then
		// measures what the compaction left, and its long read does not keep
		// the VACUUM's write-ahead log from being folded back.
		if d.quiet(now) {
			d.compactDB(ctx, &cs)
			now = time.Now()
		}
		d.storage.mu.Lock()
		tried := d.storage.tried
		d.storage.mu.Unlock()
		if idleDue(tried, activity, now, storageMaxAge) {
			d.startMeasure(now)
		}
	}
}
