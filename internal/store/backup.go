package store

import (
	"context"
	"database/sql"
	"encoding/json"
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

// MetaCopySkipped is the meta key that records an upgrade which went on
// without the copy backup keeps (a CopySkip, as JSON); absent when the copy
// was made or none was due.
const MetaCopySkipped = "upgrade_copy_skipped"

// CopySkip is why no copy was kept before migration Before: the disk had
// FreeBytes where NeedBytes were wanted, or Error says what failed. GET
// /v1/status reports it as upgrade_copy_skipped: without the copy no older
// Caprock opens the database again, and a log line was all that said so.
type CopySkip struct {
	Before    int    `json:"before"`
	At        int64  `json:"at"`
	FreeBytes int64  `json:"free_bytes,omitempty"`
	NeedBytes int64  `json:"need_bytes,omitempty"`
	Error     string `json:"error,omitempty"`
}

// CopySkipped is the upgrade recorded as having gone on without its copy, or
// nil.
func (s *Store) CopySkipped(ctx context.Context) (*CopySkip, error) {
	v, err := s.GetMeta(ctx, MetaCopySkipped)
	if err != nil || v == "" {
		return nil, err
	}
	var c CopySkip
	if err := json.Unmarshal([]byte(v), &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// skipCopy records c, so the daemon can say there is no way back, and logs it.
func (s *Store) skipCopy(ctx context.Context, c CopySkip, msg string, attrs ...any) {
	c.At = nowMs()
	if b, err := json.Marshal(c); err == nil {
		if err := s.SetMeta(ctx, MetaCopySkipped, string(b)); err != nil {
			s.log.Warn("could not record that no copy was kept", "component", "store", "err", err)
		}
	}
	s.log.Warn(msg, append([]any{"component", "store"}, attrs...)...)
}

// backup copies the database to BackupPath through SQLite's online backup,
// which reads one snapshot, write-ahead log included. Best-effort: without
// the disk for a copy the upgrade goes on without one, and says so, in the
// log and in meta (CopySkipped).
func (s *Store) backup(ctx context.Context, before int) {
	dst := BackupPath(s.path, before)
	var size int64
	if err := s.db.QueryRowContext(ctx,
		`SELECT page_count * page_size FROM pragma_page_count, pragma_page_size`).Scan(&size); err != nil {
		s.skipCopy(ctx, CopySkip{Before: before, Error: err.Error()}, "no copy kept before the upgrade", "err", err)
		return
	}
	dir := filepath.Dir(dst)
	need := size * 11 / 10
	if free, err := diskFree(dir); err != nil || free < need {
		c := CopySkip{Before: before, FreeBytes: free, NeedBytes: need}
		if err != nil {
			c = CopySkip{Before: before, NeedBytes: need, Error: "could not read the free disk space: " + err.Error()}
		}
		s.skipCopy(ctx, c, "not enough free disk to keep a copy of the database before the upgrade; an older Caprock will not open it after",
			"dir", dir, "free_bytes", free, "need_bytes", need, "err", err)
		return
	}
	_ = os.Remove(dst) // a copy from an upgrade that failed is that same database
	start := time.Now()
	if err := copyDB(ctx, s.db, dst); err != nil {
		_ = os.Remove(dst)
		s.skipCopy(ctx, CopySkip{Before: before, Error: err.Error()}, "no copy kept before the upgrade", "path", dst, "err", err)
		return
	}
	// A start that could not copy, then one that could: the way back exists.
	if _, err := s.db.ExecContext(ctx, `DELETE FROM meta WHERE k = ?`, MetaCopySkipped); err != nil {
		s.log.Warn("could not clear the record of a skipped copy", "component", "store", "err", err)
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
