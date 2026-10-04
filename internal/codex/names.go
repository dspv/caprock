package codex

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

// Codex keeps its own index of threads beside the transcripts, in
// `~/.codex/state_<N>.sqlite`. Two columns there tell sessions apart (FB-035):
//
//   - `name` — the short title Codex generates for a thread ("Check the dates
//     without two articles", in the user's language), which is what its own thread list shows. Present on 94 of
//     160 threads on the machine this was built against.
//   - `first_user_message` — what the user actually typed first, already
//     stripped of the AGENTS.md and environment blocks Codex injects ahead of
//     it in the transcript. The transcript's own user messages are unusable
//     for this: of 60 rollouts checked, every one opened with injected
//     instructions or an auto-review request.
//
// The transcripts stay the source for turns, tools and cost; this index is
// read only for names, read-only, and only when it has changed.

// ThreadName is Codex's name for one thread.
type ThreadName struct {
	Name         string
	FirstMessage string
}

// StateDB returns the newest `state_<N>.sqlite` in the Codex home that holds
// the sessions directory, or "" when there is none. The number is Codex's own
// schema generation; the newest one is the one it writes.
func StateDB(sessionsDir string) string {
	if sessionsDir == "" {
		return ""
	}
	matches, _ := filepath.Glob(filepath.Join(filepath.Dir(sessionsDir), "state_*.sqlite"))
	gen := func(p string) int {
		n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(filepath.Base(p), "state_"), ".sqlite"))
		if err != nil {
			return -1
		}
		return n
	}
	sort.Slice(matches, func(i, j int) bool { return gen(matches[i]) > gen(matches[j]) })
	for _, m := range matches {
		if gen(m) >= 0 {
			return m
		}
	}
	return ""
}

// ReadThreadNames reads every thread's name and first message. A database
// whose `threads` table lacks a column is a Codex release this was not built
// against, and is reported as an error rather than half-read.
func ReadThreadNames(ctx context.Context, path string) (map[string]ThreadName, error) {
	if path == "" {
		return nil, errors.New("codex: no state database")
	}
	// Read-only: this must never take a write lock on Codex's live database.
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("codex: open state: %w", err)
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	rows, err := db.QueryContext(ctx, `SELECT id, COALESCE(name,''), COALESCE(first_user_message,'') FROM threads`)
	if err != nil {
		return nil, fmt.Errorf("codex: read threads: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]ThreadName{}
	for rows.Next() {
		var id string
		var n ThreadName
		if err := rows.Scan(&id, &n.Name, &n.FirstMessage); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// stateStamp is what decides whether the index changed: SQLite in WAL mode
// writes the -wal file first, so the main file's time alone lags.
func stateStamp(path string) time.Time {
	var latest time.Time
	for _, p := range []string{path, path + "-wal"} {
		if fi, err := os.Stat(p); err == nil && fi.ModTime().After(latest) {
			latest = fi.ModTime()
		}
	}
	return latest
}
