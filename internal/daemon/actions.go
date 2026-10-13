package daemon

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/ptyhost"
)

// What Caprock did about its own footprint without being asked. Nobody
// cleans up after a user's Caprock but Caprock, so every remedy that is safe
// to apply on its own is applied on its own — the orphaned-holder sweep, the
// write-ahead log checkpoint — and said here, so the footprint can tell a
// person what happened and when. In memory only: the last actionLogLen, gone
// with the daemon.
const actionLogLen = 50

// FootprintAction is one thing the daemon did on its own.
type FootprintAction struct {
	At   int64  `json:"at"` // unix ms
	What string `json:"what"`
}

type actionLog struct {
	mu   sync.Mutex
	list []FootprintAction
	now  func() time.Time
}

func newActionLog() *actionLog { return &actionLog{now: time.Now} }

func (l *actionLog) add(what string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.list = append(l.list, FootprintAction{At: l.now().UnixMilli(), What: what})
	if n := len(l.list); n > actionLogLen {
		l.list = append(l.list[:0], l.list[n-actionLogLen:]...)
	}
}

// all is the log, oldest first.
func (l *actionLog) all() []FootprintAction {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]FootprintAction{}, l.list...)
}

// reapAction says what a reap stopped, in words.
func reapAction(reaped []ptyhost.Verdict, asked bool) string {
	var dead, idle, gone int
	for _, v := range reaped {
		if v.State == "dead" {
			dead++
		} else {
			idle++
		}
		if v.Abandoned {
			gone++
		}
	}
	s := "stopped " + plural(len(reaped), "orphaned terminal holder")
	var why []string
	if idle > 0 {
		why = append(why, fmt.Sprintf("%d holding only an idle shell", idle))
	}
	if dead > 0 {
		why = append(why, fmt.Sprintf("%d whose program had exited", dead))
	}
	if gone > 0 {
		why = append(why, fmt.Sprintf("%d left by a Caprock whose data directory is deleted", gone))
	}
	if len(why) > 0 {
		s += " (" + joinAnd(why) + ")"
	}
	if asked {
		s += ", asked from Settings"
	}
	return s
}

func joinAnd(parts []string) string {
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	}
	out := parts[0]
	for _, p := range parts[1 : len(parts)-1] {
		out += ", " + p
	}
	return out + " and " + parts[len(parts)-1]
}

// walCheckpointEvery is how often a large write-ahead log is tried again
// after a checkpoint that could not finish (a long read was in the way).
const walCheckpointEvery = 10 * time.Minute

// checkpointWAL folds an oversized write-ahead log back into the database —
// what SQLite's automatic checkpoint does in small steps, done at once and
// with the file truncated after. Safe on a live database: SQLite takes the
// locks it needs and leaves the frames a running read still uses for the
// next time. Called from ioLoop, once a minute; does nothing below
// footprintWALWarn.
func (d *Daemon) checkpointWAL(ctx context.Context, last *time.Time) {
	wal := config.DBPath(d.opt.DataDir) + "-wal"
	info, err := os.Stat(wal)
	if err != nil || info.Size() <= footprintWALWarn || time.Since(*last) < walCheckpointEvery {
		return
	}
	*last = time.Now()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var busy, frames, done int64
	if err := d.store.DB().QueryRowContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &frames, &done); err != nil {
		d.log.Warn("could not checkpoint the write-ahead log", "component", "daemon", "err", err)
		return
	}
	after := int64(0)
	if st, err := os.Stat(wal); err == nil {
		after = st.Size()
	}
	what := fmt.Sprintf("folded the %s write-ahead log back into the database (now %s)", Bytes(uint64(info.Size())), Bytes(uint64(after)))
	if busy != 0 {
		what = fmt.Sprintf("folded what it could of the %s write-ahead log back into the database (now %s); a running read held the rest, tried again in %d minutes",
			Bytes(uint64(info.Size())), Bytes(uint64(after)), int(walCheckpointEvery/time.Minute))
	}
	d.actions.add(what)
	d.log.Info("checkpointed the write-ahead log", "component", "daemon", "before", info.Size(), "after", after, "busy", busy)
}
