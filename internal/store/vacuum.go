package store

import (
	"context"
	"fmt"
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
