package store

import (
	"errors"

	"modernc.org/sqlite"
)

// SQLite's primary result codes for "someone else holds the lock", and the
// extended one for a NOT NULL column left NULL. Extended codes
// (SQLITE_BUSY_SNAPSHOT is 517 = 5 | 2<<8) carry the primary code in their
// low byte.
const (
	sqliteBusy              = 5
	sqliteLocked            = 6
	sqliteConstraintNotNull = 19 | 5<<8
)

// IsBusy reports whether err is SQLite saying the database was locked by
// another connection — a write that would succeed if tried again, as opposed
// to one that is wrong. Callers that would otherwise drop the record they were
// writing use it to keep it for a later attempt instead.
func IsBusy(err error) bool {
	var e *sqlite.Error
	if !errors.As(err, &e) {
		return false
	}
	switch e.Code() & 0xff {
	case sqliteBusy, sqliteLocked:
		return true
	}
	return false
}

func isNotNull(err error) bool {
	var e *sqlite.Error
	return errors.As(err, &e) && e.Code() == sqliteConstraintNotNull
}
