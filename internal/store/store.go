// Package store owns the SQLite database: opening, migrating, and every query.
// Nothing else in Caprock issues SQL. Pure Go driver (modernc.org/sqlite), no CGO
// — see ADR-012.
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Meta keys.
const (
	MetaSchemaVersion = "schema_version"
	// MetaTranscriptSchema records the parser version that wrote the events, so
	// a bump can trigger a one-time re-derivation of affected payloads.
	MetaTranscriptSchema = "transcript_schema_version"
	MetaPricingVersion   = "pricing_version"
)

// maxOpenConns bounds the pool. Loopback traffic is one dashboard plus the
// ingest path, so this is about removing a queue rather than scaling out; a
// small number keeps file descriptors and memory predictable.
const maxOpenConns = 8

// Store wraps the database handle.
type Store struct {
	db  *sql.DB
	log *slog.Logger
}

// Open opens (creating if needed) the SQLite database at path and applies pending
// migrations. Use ":memory:" for tests.
// memSeq names in-memory databases uniquely; see the ":memory:" branch in Open.
var memSeq atomic.Int64

func Open(ctx context.Context, path string, log *slog.Logger) (*Store, error) {
	if log == nil {
		log = slog.Default()
	}
	var dsn string
	if path == ":memory:" {
		// A bare ":memory:" gives every pooled connection its own empty
		// database, so a second connection sees no tables — which surfaces as
		// "no such table" the moment anything runs concurrently, and reads
		// exactly like a product bug. cache=shared fixes that, but a shared
		// *unnamed* database is shared process-wide, so parallel tests would
		// see each other's rows. A unique name per Open gives each caller one
		// database that its own pool shares and nobody else can reach.
		dsn = fmt.Sprintf("file:memdb%d?mode=memory&cache=shared&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)",
			memSeq.Add(1))
	} else {
		// _pragma is modernc's DSN syntax. WAL lets the UI read while ingest writes;
		// busy_timeout avoids SQLITE_BUSY under the (rare) concurrent writer.
		dsn = "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// SQLite allows one writer but any number of concurrent readers under WAL,
	// which is why WAL is on. Capping the pool at one connection threw that
	// away: every dashboard read queued behind ingest, so an endpoint whose
	// queries take 150ms was answering in 400-780ms, varying with how busy the
	// tailer happened to be.
	//
	// Reads now get their own connections. Writes still serialize, because the
	// recorder is the single write path and busy_timeout covers the rest.
	db.SetMaxOpenConns(maxOpenConns)
	db.SetMaxIdleConns(maxOpenConns)
	db.SetConnMaxIdleTime(5 * time.Minute)
	s := &Store{db: db, log: log}
	if err := s.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	// Repository grouping needs the filesystem to resolve a root, which SQL
	// cannot do, so migration 0011's backfill lives here. It is idempotent and
	// touches only rows the migration left NULL, so a normal open does one
	// cheap query and stops.
	if err := s.backfillRepo(ctx); err != nil {
		// A failed backfill leaves old labels in place — degraded, not broken —
		// and must never stop the daemon from opening its own database.
		s.log.Warn("repository backfill incomplete; some projects keep their old labels",
			"component", "store", "err", err)
	}
	return s, nil
}

// backfillRepo fills repo_root/repo_path (and re-derives project) for sessions
// written before repository grouping existed.
//
// Historical rows are the reason the resolution is stored rather than derived
// on read: their directories may already be gone, so this records the best
// answer available now — a real root while the directory exists, a stable
// path-derived label when it does not — instead of letting a label change every
// time a scratchpad is cleaned up.
func (s *Store) backfillRepo(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx,
		`SELECT session_id, COALESCE(cwd,'') FROM sessions WHERE repo_root IS NULL`)
	if err != nil {
		return err
	}
	type row struct{ id, cwd string }
	var pending []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.cwd); err != nil {
			_ = rows.Close()
			return err
		}
		pending = append(pending, r)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(pending) == 0 {
		return nil
	}
	err = s.WithTx(ctx, func(q Querier) error {
		for _, r := range pending {
			info := RepoFromCwd(r.cwd)
			if _, err := q.ExecContext(ctx,
				`UPDATE sessions SET repo_root = ?, repo_path = ?,
				 project = CASE WHEN ? != '' THEN ? ELSE project END
				 WHERE session_id = ?`,
				info.Root, info.Path, info.Repo, info.Repo, r.id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.log.Info("repository grouping backfilled", "component", "store", "sessions", len(pending))
	return nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// DB exposes the raw handle for packages that need transactions (rollup).
func (s *Store) DB() *sql.DB { return s.db }

// SchemaVersion returns the applied schema version (0 = empty database).
func (s *Store) SchemaVersion(ctx context.Context) (int, error) {
	v, err := s.GetMeta(ctx, MetaSchemaVersion)
	if err != nil {
		return 0, err
	}
	if v == "" {
		return 0, nil
	}
	return strconv.Atoi(v)
}

// GetMeta reads a meta value; "" when absent.
func (s *Store) GetMeta(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT v FROM meta WHERE k = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		// A brand-new database has no meta table yet.
		if strings.Contains(err.Error(), "no such table") {
			return "", nil
		}
		return "", err
	}
	return v, nil
}

// SetMeta upserts a meta value.
func (s *Store) SetMeta(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, key, value)
	return err
}

type migration struct {
	version int
	name    string
	sql     string
}

func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		return nil, err
	}
	var out []migration
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".sql") {
			continue
		}
		prefix, _, ok := strings.Cut(name, "_")
		if !ok {
			return nil, fmt.Errorf("migration %q: expected NNNN_name.sql", name)
		}
		v, err := strconv.Atoi(prefix)
		if err != nil {
			return nil, fmt.Errorf("migration %q: bad version prefix: %w", name, err)
		}
		b, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return nil, err
		}
		out = append(out, migration{version: v, name: name, sql: string(b)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	for i, m := range out {
		if m.version != i+1 {
			return nil, fmt.Errorf("migrations are not sequential: %s has version %d, expected %d", m.name, m.version, i+1)
		}
	}
	return out, nil
}

// migrate applies embedded migrations sequentially, gated by meta.schema_version.
// Each migration runs in its own transaction; a failure leaves the database at the
// last fully-applied version.
func (s *Store) migrate(ctx context.Context) error {
	migs, err := loadMigrations()
	if err != nil {
		return err
	}
	current, err := s.SchemaVersion(ctx)
	if err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	for _, m := range migs {
		if m.version <= current {
			continue
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, m.sql); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration %s: %w", m.name, err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
			MetaSchemaVersion, strconv.Itoa(m.version)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("record migration %s: %w", m.name, err)
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		s.log.Info("migration applied", "component", "store", "migration", m.name)
	}
	return nil
}

// nowMs is overridable in tests.
var nowMs = func() int64 { return time.Now().UnixMilli() }
