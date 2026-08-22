package store

import (
	"errors"
	"io/fs"
	"os"
	"runtime"
)

// dbFileMode is the only mode the database may have: readable and writable by
// its owner, invisible to every other account on the machine.
//
// The database stores prompts and responses in cleartext — the whole point of
// the Answers screen is that Claude's prose is searchable — so a world-readable
// file hands every other local account the user's entire session history.
// config.json beside it has always been 0600; the database was left at whatever
// the process umask produced, which on a default umask is 0644.
const dbFileMode fs.FileMode = 0o600

// secureDBFiles tightens the database and its WAL/shared-memory siblings to
// 0600. It runs on every Open, not only on creation: a database created before
// this existed keeps its 0644 until something changes it, and SQLite recreates
// -wal and -shm on demand under the process umask, so a one-time fix at
// creation would silently regress on the next open.
//
// Errors are returned per file by the caller's policy: a database we cannot
// chmod is a warning rather than a fatal, because refusing to start would turn
// a permissions nit into an outage on a filesystem that has no modes at all
// (a mounted share, a container volume).
//
// On Windows this is a no-op: NTFS has no POSIX mode bits, os.Chmod there only
// toggles the read-only attribute, and applying 0600 would do nothing useful
// while risking a read-only database. Windows access is governed by the ACL the
// file inherits from the per-user data directory, which is already user-scoped.
func secureDBFiles(path string) error {
	if runtime.GOOS == "windows" || path == "" || path == ":memory:" {
		return nil
	}
	var firstErr error
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		// A missing sibling is normal: -wal and -shm exist only while a
		// connection is open in WAL mode.
		fi, err := os.Stat(p)
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) && firstErr == nil {
				firstErr = err
			}
			continue
		}
		if fi.Mode().Perm() == dbFileMode {
			continue
		}
		if err := os.Chmod(p, dbFileMode); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
