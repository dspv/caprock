package store

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
)

// A transaction that reads before it writes must wait for the lock, not fail.
//
// The recorder's transaction asks whether another session already paid for a
// turn and then inserts it. Begun DEFERRED, that is a reader upgrading to a
// writer, and SQLite refuses the upgrade at once — busy_timeout never runs —
// whenever another writer holds the lock or has committed since the read. On
// the owner's machine that dropped ~400 transcript turns an hour. Begun
// IMMEDIATE, every writer queues on the lock and every one of them lands.
func TestReadThenWriteTransactionsDoNotFailBusy(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "c.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	const writers, each = 8, 25
	var wg sync.WaitGroup
	errs := make(chan error, writers*each)
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < each; i++ {
				errs <- s.WithTx(ctx, func(q Querier) error {
					var n int
					if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM meta`).Scan(&n); err != nil {
						return err
					}
					_, err := q.ExecContext(ctx, `INSERT INTO meta(k, v) VALUES(?, ?)`, fmt.Sprintf("w%d-%d", w, i), n)
					return err
				})
			}
		}(w)
	}
	wg.Wait()
	close(errs)
	failed := 0
	for err := range errs {
		if err != nil {
			failed++
			if failed == 1 {
				t.Errorf("a read-then-write transaction failed: %v", err)
			}
		}
	}
	if failed > 0 {
		t.Errorf("%d of %d transactions failed — each is a record ingest would have dropped", failed, writers*each)
	}
}

// IsBusy is what decides whether ingest keeps a line for another attempt or
// gives up on it, so it has to recognise the error SQLite really returns.
func TestIsBusyRecognisesALockedDatabase(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "c.db")
	s, err := Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	holder, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(0)")
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	conn, err := holder.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `BEGIN IMMEDIATE`); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = conn.ExecContext(ctx, `ROLLBACK`) }()

	other, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(0)")
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	_, err = other.ExecContext(ctx, `INSERT INTO meta(k, v) VALUES('x', 'y')`)
	if err == nil {
		t.Fatal("a second writer got in while the lock was held")
	}
	if !IsBusy(fmt.Errorf("insert event: %w", err)) {
		t.Errorf("IsBusy(%v) = false; a locked database would be treated as a bad record and dropped", err)
	}
	if IsBusy(fmt.Errorf("event without session_id")) {
		t.Error("IsBusy accepted an error that is not a lock; that record would be retried forever")
	}
}
