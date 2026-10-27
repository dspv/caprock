package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/disk"
	"modernc.org/sqlite"
)

// backupBefore are the migrations no older Caprock reads past: before the
// first of them still to run, Open keeps a copy of the database as it was,
// which is the only way back to the older release (ADR-082).
var backupBefore = []int{73}

// BackupPath is where the copy kept before migration v goes, beside the
// database: caprock.pre-0073.db for caprock.db.
func BackupPath(dbPath string, v int) string {
	base := strings.TrimSuffix(filepath.Base(dbPath), filepath.Ext(dbPath))
	return filepath.Join(filepath.Dir(dbPath), fmt.Sprintf("%s.pre-%04d.db", base, v))
}

func Backups(dbPath string) []string {
	base := strings.TrimSuffix(filepath.Base(dbPath), filepath.Ext(dbPath))
	m, _ := filepath.Glob(filepath.Join(filepath.Dir(dbPath), base+".pre-[0-9][0-9][0-9][0-9].db"))
	return m
}

type Option func(*Store)

// OnUpgrade is called before Open copies the database ahead of a migration
// (backupBefore), and the done it returns once the migrations have run.
func OnUpgrade(fn func() (done func())) Option {
	return func(s *Store) { s.onUpgrade = fn }
}

var diskFree = func(dir string) (int64, error) {
	u, err := disk.Usage(dir)
	if err != nil {
		return 0, err
	}
	return int64(min(u.Free, uint64(1)<<62)), nil
}

// backupDue is the migration in backupBefore a database at schema current
// is about to cross, or 0. A new database has nothing to keep.
func backupDue(migs []migration, current int) int {
	if current == 0 {
		return 0
	}
	for _, v := range backupBefore {
		if current < v && v <= migs[len(migs)-1].version {
			return v
		}
	}
	return 0
}

// backup copies the database to BackupPath through SQLite's online backup,
// which reads one snapshot, write-ahead log included. Best-effort: without
// the disk for a copy the upgrade goes on without one, and says so.
func (s *Store) backup(ctx context.Context, before int) {
	dst := BackupPath(s.path, before)
	var size int64
	if err := s.db.QueryRowContext(ctx,
		`SELECT page_count * page_size FROM pragma_page_count, pragma_page_size`).Scan(&size); err != nil {
		s.log.Warn("no copy kept before the upgrade", "component", "store", "err", err)
		return
	}
	dir := filepath.Dir(dst)
	if free, err := diskFree(dir); err != nil || free < size*11/10 {
		s.log.Warn("not enough free disk to keep a copy of the database before the upgrade; an older Caprock will not open it after",
			"component", "store", "dir", dir, "free_bytes", free, "need_bytes", size*11/10, "err", err)
		return
	}
	_ = os.Remove(dst) // a copy from an upgrade that failed is that same database
	start := time.Now()
	if err := copyDB(ctx, s.db, dst); err != nil {
		_ = os.Remove(dst)
		s.log.Warn("no copy kept before the upgrade", "component", "store", "path", dst, "err", err)
		return
	}
	// It holds prompts and responses in cleartext, as the database does.
	_ = os.Chmod(dst, 0o600)
	s.log.Info("kept a copy of the database from before the upgrade", "component", "store",
		"path", dst, "bytes", size, "took", time.Since(start).Round(time.Millisecond))
}

func copyDB(ctx context.Context, db *sql.DB, dst string) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	return conn.Raw(func(dc any) error {
		if tc, ok := dc.(*timedConn); ok {
			dc = tc.fullConn
		}
		src, ok := dc.(interface {
			NewBackup(string) (*sqlite.Backup, error)
		})
		if !ok {
			return fmt.Errorf("the driver cannot back up (%T)", dc)
		}
		b, err := src.NewBackup(dst)
		if err != nil {
			return err
		}
		if _, err := b.Step(-1); err != nil {
			_ = b.Finish()
			return err
		}
		return b.Finish()
	})
}
