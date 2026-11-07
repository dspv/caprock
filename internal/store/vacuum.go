package store

import (
	"context"
	"fmt"
	"time"
)

// Giving free pages back to the disk.
//
// A row that shrinks or goes leaves its pages on SQLite's freelist: reused by
// the next rows, never returned to the disk. A database created with
// auto_vacuum=NONE (every Caprock database before 2026-10-13) can only give
// them back by a full VACUUM, which rewrites the file. With
// auto_vacuum=INCREMENTAL the file records where each page belongs, and
// `PRAGMA incremental_vacuum(N)` moves N free pages to the end and cuts them
// off — a short write, as often as wanted.
//
// Switching a database that has tables to INCREMENTAL takes one VACUUM. The
// daemon runs it once, while idle and only with the disk to spare
// (internal/daemon/compact.go); from then on it frees pages in small steps.

// AutoVacuumIncremental is PRAGMA auto_vacuum's value for INCREMENTAL.
const AutoVacuumIncremental = 2

// PageCounts is the database file in pages.
type PageCounts struct {
	PageSize int64
	Pages    int64
	Free     int64
}

// Bytes is the file's size; FreeBytes the freelist's.
func (p PageCounts) Bytes() int64     { return p.Pages * p.PageSize }
func (p PageCounts) FreeBytes() int64 { return p.Free * p.PageSize }

// AutoVacuum is the database's auto_vacuum mode: 0 NONE, 1 FULL, 2
// INCREMENTAL.
func (s *Store) AutoVacuum(ctx context.Context) (int, error) {
	var v int
	err := s.db.QueryRowContext(ctx, `PRAGMA auto_vacuum`).Scan(&v)
	return v, err
}

// Pages reads the page size, the page count and the freelist.
func (s *Store) Pages(ctx context.Context) (PageCounts, error) {
	var p PageCounts
	for _, q := range []struct {
		name string
		dst  *int64
	}{{"page_size", &p.PageSize}, {"page_count", &p.Pages}, {"freelist_count", &p.Free}} {
		if err := s.db.QueryRowContext(ctx, "PRAGMA "+q.name).Scan(q.dst); err != nil {
			return p, fmt.Errorf("pragma %s: %w", q.name, err)
		}
	}
	return p, nil
}

// EnableIncrementalVacuum sets auto_vacuum=INCREMENTAL and runs the VACUUM
// that makes it take effect, which also gives every free page back. Both
// statements go to one connection: the mode is that connection's request to
// its next VACUUM.
//
// VACUUM copies the database to a temporary file and writes it back through
// the write-ahead log, holding the write lock throughout; the caller decides
// when that is affordable. Cancelling ctx interrupts it, and an interrupted
// VACUUM rolls back and leaves the database as it was.
func (s *Store) EnableIncrementalVacuum(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `PRAGMA auto_vacuum = INCREMENTAL`); err != nil {
		return fmt.Errorf("set auto_vacuum: %w", err)
	}
	if _, err := conn.ExecContext(ctx, `VACUUM`); err != nil {
		return fmt.Errorf("vacuum: %w", err)
	}
	return nil
}

// IncrementalVacuum returns up to n free pages to the disk and says how many
// it returned. On a database not in INCREMENTAL mode it does nothing.
func (s *Store) IncrementalVacuum(ctx context.Context, n int) (int64, error) {
	before, err := s.Pages(ctx)
	if err != nil {
		return 0, err
	}
	if before.Free == 0 {
		return 0, nil
	}
	if _, err := s.db.ExecContext(ctx, fmt.Sprintf(`PRAGMA incremental_vacuum(%d)`, max(n, 1))); err != nil {
		return 0, fmt.Errorf("incremental_vacuum: %w", err)
	}
	after, err := s.Pages(ctx)
	if err != nil {
		return 0, err
	}
	return max(before.Free-after.Free, 0), nil
}

// CheckpointTruncate folds the write-ahead log back into the database and
// truncates it. busy is non-zero when a running read kept part of it.
func (s *Store) CheckpointTruncate(ctx context.Context) (busy int64, err error) {
	var frames, done int64
	err = s.db.QueryRowContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &frames, &done)
	return busy, err
}

// Pack runs the VACUUM a user asked for (internal/daemon/pack.go): the same
// rewrite as EnableIncrementalVacuum, switching the database to INCREMENTAL
// on the way, but with this connection's automatic checkpoint off, so the
// statement returns as soon as the packed database is committed to the
// write-ahead log. Folding that log back into the file is the caller's next
// step (CheckpointPassive), which holds no lock a writer needs: on a copy of
// the owner's database the fold was a fifth of the run, 12 s of 56
// (2026-11-07), and writers no longer wait for it.
//
// The connection goes back to the pool with its automatic checkpoint as it
// was. Cancelling ctx interrupts the VACUUM, which then rolls back and
// leaves the database as it was.
func (s *Store) Pack(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	var auto int64
	if err := conn.QueryRowContext(ctx, `PRAGMA wal_autocheckpoint`).Scan(&auto); err != nil {
		return fmt.Errorf("read wal_autocheckpoint: %w", err)
	}
	// Restored on a context the caller cannot cancel: a pooled connection
	// left with no automatic checkpoint would let the log grow unbounded.
	defer func() {
		_, _ = conn.ExecContext(context.WithoutCancel(ctx), fmt.Sprintf(`PRAGMA wal_autocheckpoint = %d`, auto))
	}()
	if _, err := conn.ExecContext(ctx, `PRAGMA wal_autocheckpoint = 0`); err != nil {
		return fmt.Errorf("set wal_autocheckpoint: %w", err)
	}
	if _, err := conn.ExecContext(ctx, `PRAGMA auto_vacuum = INCREMENTAL`); err != nil {
		return fmt.Errorf("set auto_vacuum: %w", err)
	}
	if _, err := conn.ExecContext(ctx, `VACUUM`); err != nil {
		return fmt.Errorf("vacuum: %w", err)
	}
	return nil
}

// CheckpointPassive copies as much of the write-ahead log into the database
// as no reader still needs, without waiting for anyone and without blocking
// a writer. It returns the log's frames and how many were copied.
func (s *Store) CheckpointPassive(ctx context.Context) (frames, done int64, err error) {
	var busy int64
	err = s.db.QueryRowContext(ctx, `PRAGMA wal_checkpoint(PASSIVE)`).Scan(&busy, &frames, &done)
	return frames, done, err
}

// CheckpointTruncateWithin is CheckpointTruncate on a connection that waits
// at most wait for the readers in its way. A TRUNCATE checkpoint holds the
// write lock while it waits, so with the pool's five seconds every writer
// waits that long behind it; after a pack the log is large and a running
// read is likely, so the pack gives it a fraction of a second and leaves the
// rest to SQLite's own checkpoints (journal_size_limit trims the file when
// the log next starts over).
func (s *Store) CheckpointTruncateWithin(ctx context.Context, wait time.Duration) (busy int64, err error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	var prev int64
	if err := conn.QueryRowContext(ctx, `PRAGMA busy_timeout`).Scan(&prev); err != nil {
		return 0, err
	}
	defer func() {
		_, _ = conn.ExecContext(context.WithoutCancel(ctx), fmt.Sprintf(`PRAGMA busy_timeout = %d`, prev))
	}()
	if _, err := conn.ExecContext(ctx, fmt.Sprintf(`PRAGMA busy_timeout = %d`, max(wait.Milliseconds(), 1))); err != nil {
		return 0, err
	}
	var frames, done int64
	err = conn.QueryRowContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &frames, &done)
	return busy, err
}
