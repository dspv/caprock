//go:build windows

package daemon

// sqliteTempBytes has no reading on Windows: SQLite's temporary files there
// keep their names until closed, under names nothing ties to this process,
// so the copy phase of a pack reports no progress of its own (-1).
func sqliteTempBytes() (int64, bool) { return 0, false }
