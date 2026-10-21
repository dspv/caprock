package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// SchemaTooNewError is a database that a newer Caprock has migrated past the
// last migration this binary carries (ADR-082). Opening it anyway is how a
// downgrade loses data: this binary would run its jobs — backfills, retention,
// cleanup, VACUUM — against tables whose shape it does not know, and nothing
// would say so. So the open is refused before anything is written.
type SchemaTooNewError struct {
	Path     string // the database file, "" for an in-memory one
	Database int    // meta.schema_version as the newer Caprock left it
	Binary   int    // the highest migration embedded in this binary
}

func (e *SchemaTooNewError) Error() string {
	what := "the database"
	if e.Path != "" {
		what = "the database " + e.Path
	}
	return fmt.Sprintf("%s is from a newer Caprock (schema %d; this Caprock knows up to %d): install the newer Caprock to open it — nothing was changed",
		what, e.Database, e.Binary)
}

// LatestSchema is the highest migration number embedded in this binary.
func LatestSchema() (int, error) {
	migs, err := loadMigrations()
	if err != nil {
		return 0, err
	}
	if len(migs) == 0 {
		return 0, nil
	}
	return migs[len(migs)-1].version, nil
}

// CheckSchema reads meta.schema_version from the database at path without
// the ability to write it, and returns a *SchemaTooNewError when the database
// is newer than this binary. A missing file, or a database with no meta table
// yet, is version 0 and passes. Open runs it before it sets a single pragma,
// so a refused database is left byte for byte as it was found.
//
// Any other failure (a file that is not a database, a lock that outlasts the
// busy timeout) is returned as is.
func CheckSchema(ctx context.Context, path string) error {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	latest, err := LatestSchema()
	if err != nil {
		return err
	}
	db, err := sql.Open("sqlite", readOnlyDSN(path))
	if err != nil {
		return err
	}
	// Closed before returning, so Windows lets the caller open, rename or
	// delete the file straight after.
	defer db.Close()
	db.SetMaxOpenConns(1)
	var v string
	err = db.QueryRowContext(ctx, `SELECT v FROM meta WHERE k = ?`, MetaSchemaVersion).Scan(&v)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil
	case err != nil && strings.Contains(err.Error(), "no such table"):
		return nil
	case err != nil:
		return err
	}
	return schemaNewer(path, v, latest)
}

// schemaNewer compares a recorded schema_version with this binary's latest.
// Equal or older passes: older is what migrate is for. An unreadable value
// is not called newer — no Caprock wrote it, and migrate refuses it with its
// own error before writing.
func schemaNewer(path, recorded string, latest int) error {
	n, convErr := strconv.Atoi(strings.TrimSpace(recorded))
	if convErr != nil || n <= latest {
		return nil //nolint:nilerr // unreadable is not newer; migrate reports it
	}
	return &SchemaTooNewError{Path: path, Database: n, Binary: latest}
}

// readOnlyDSN is a mode=ro file: URI for path. A file: URI keeps a space
// (macOS "Application Support"), '#' or '?' out of the query string, and a
// Windows drive path is spelled the way SQLite's URI parser expects
// (file:///C:/…). It sets no pragma that writes: no journal_mode, no
// auto_vacuum.
func readOnlyDSN(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	p := filepath.ToSlash(abs)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // C:/x → /C:/x
	}
	u := url.URL{Scheme: "file", Path: p, RawQuery: "mode=ro&_pragma=busy_timeout(5000)"}
	return u.String()
}
