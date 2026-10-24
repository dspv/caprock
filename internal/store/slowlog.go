package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"time"
)

// SlowQuery is how long one statement may take before it is logged.
//
// Why the log exists. The owner's daemon twice read 1–1.7 GB from disk within
// a minute, a quarter of an hour apart (2026-10-13), and nothing on record
// said which code did it: the dashboard's requests, a startup repair and the
// storage measurement all read the same file through the same pool. Every
// statement now goes through a timed connection, so the next spike names its
// caller in the log instead of being reconstructed from guesses.
//
// The time is wall time from the statement's start until its rows are closed,
// so it includes what the caller did between rows. That is deliberate: a
// result set held open for a second keeps a read snapshot (and the WAL behind
// it) for that second whatever the reason.
const SlowQuery = 300 * time.Millisecond

// slowClock is time.Now, swapped in tests.
var slowClock = time.Now

// QueryStat is the running tally of one statement that has been slow at
// least once since the daemon started.
type QueryStat struct {
	Query   string `json:"query"`
	Caller  string `json:"caller"`
	Times   int64  `json:"times"`
	TotalMs int64  `json:"total_ms"`
	MaxMs   int64  `json:"max_ms"`
	Rows    int64  `json:"rows"`
}

// slowTally keeps a running QueryStat per statement, so each log line also
// says how often that statement has been slow since the daemon started and
// for how long in all — the counter, without a profiler. It is bounded: past
// maxSlowKinds distinct statements new ones are logged but not tallied.
type slowTally struct {
	mu sync.Mutex
	m  map[string]*QueryStat
}

const maxSlowKinds = 256

func (t *slowTally) add(name, caller string, d time.Duration, rows int64) QueryStat {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.m == nil {
		t.m = map[string]*QueryStat{}
	}
	s := t.m[name]
	if s == nil {
		if len(t.m) >= maxSlowKinds {
			return QueryStat{Query: name, Caller: caller, Times: 1, TotalMs: d.Milliseconds(), MaxMs: d.Milliseconds(), Rows: rows}
		}
		s = &QueryStat{Query: name}
		t.m[name] = s
	}
	s.Caller = caller
	s.Times++
	s.TotalMs += d.Milliseconds()
	s.MaxMs = max(s.MaxMs, d.Milliseconds())
	s.Rows += rows
	return *s
}

var tally slowTally

// queryName is a statement shortened to one line for the log: whitespace
// collapsed, cut at 160 bytes.
func queryName(q string) string {
	q = strings.Join(strings.Fields(q), " ")
	if len(q) > 160 {
		q = q[:160] + "…"
	}
	return q
}

// callerOf names the code that asked for the statement. Only worked out for a
// slow one.
func callerOf() string {
	f, _ := callerFrame()
	return f.Function
}

func reportSlow(log *slog.Logger, query string, start time.Time, rows int64, err error) {
	d := slowClock().Sub(start)
	if d < SlowQuery {
		return
	}
	name := queryName(query)
	caller := callerOf()
	st := tally.add(name, caller, d, rows)
	if log == nil {
		return
	}
	args := []any{"component", "store", "ms", d.Milliseconds(), "rows", rows, "caller", caller, "query", name,
		"times", st.Times, "total_ms", st.TotalMs}
	if err != nil {
		args = append(args, "err", err)
	}
	log.Info("slow query", args...)
}

// timedConnector opens connections that time their statements.
type timedConnector struct {
	drv driver.Driver
	dsn string
	log *slog.Logger
}

func (c *timedConnector) Connect(context.Context) (driver.Conn, error) {
	conn, err := c.drv.Open(c.dsn)
	if err != nil {
		return nil, err
	}
	if fc, ok := conn.(fullConn); ok {
		return &timedConn{fullConn: fc, log: c.log}, nil
	}
	return conn, nil // a driver without the context methods: untimed
}

func (c *timedConnector) Driver() driver.Driver { return c.drv }

// fullConn is what the sqlite driver's connection implements; the wrapper
// forwards all of it so database/sql behaves exactly as it did unwrapped.
type fullConn interface {
	driver.Conn
	driver.ConnBeginTx
	driver.ConnPrepareContext
	driver.ExecerContext
	driver.QueryerContext
	driver.Pinger
	driver.SessionResetter
	driver.Validator
}

type timedConn struct {
	fullConn
	log *slog.Logger
}

func (c *timedConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	recordPlan(query, args)
	start := slowClock()
	r, err := c.fullConn.ExecContext(ctx, query, args)
	var n int64
	if err == nil {
		n, _ = r.RowsAffected()
	}
	reportSlow(c.log, query, start, n, err)
	return r, err
}

func (c *timedConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	recordPlan(query, args)
	start := slowClock()
	r, err := c.fullConn.QueryContext(ctx, query, args)
	if err != nil {
		reportSlow(c.log, query, start, 0, err)
		return nil, err
	}
	return &timedRows{Rows: r, query: query, start: start, log: c.log}, nil
}

// timedRows counts rows and reports when the result set is closed.
type timedRows struct {
	driver.Rows
	query  string
	start  time.Time
	log    *slog.Logger
	n      int64
	closed bool
}

func (r *timedRows) Next(dest []driver.Value) error {
	err := r.Rows.Next(dest)
	if err == nil {
		r.n++
	} else if !errors.Is(err, io.EOF) {
		r.report(err)
	}
	return err
}

func (r *timedRows) Close() error {
	err := r.Rows.Close()
	r.report(nil)
	return err
}

func (r *timedRows) report(err error) {
	if r.closed {
		return
	}
	r.closed = true
	reportSlow(r.log, r.query, r.start, r.n, err)
}

// The column-type methods database/sql looks for on a driver's rows,
// forwarded so ColumnTypes() answers as it does on the bare driver.

func (r *timedRows) ColumnTypeDatabaseTypeName(i int) string {
	if x, ok := r.Rows.(driver.RowsColumnTypeDatabaseTypeName); ok {
		return x.ColumnTypeDatabaseTypeName(i)
	}
	return ""
}

func (r *timedRows) ColumnTypeLength(i int) (int64, bool) {
	if x, ok := r.Rows.(driver.RowsColumnTypeLength); ok {
		return x.ColumnTypeLength(i)
	}
	return 0, false
}

func (r *timedRows) ColumnTypeNullable(i int) (bool, bool) {
	if x, ok := r.Rows.(driver.RowsColumnTypeNullable); ok {
		return x.ColumnTypeNullable(i)
	}
	return false, false
}

func (r *timedRows) ColumnTypePrecisionScale(i int) (int64, int64, bool) {
	if x, ok := r.Rows.(driver.RowsColumnTypePrecisionScale); ok {
		return x.ColumnTypePrecisionScale(i)
	}
	return 0, 0, false
}

func (r *timedRows) ColumnTypeScanType(i int) reflect.Type {
	if x, ok := r.Rows.(driver.RowsColumnTypeScanType); ok {
		return x.ColumnTypeScanType(i)
	}
	return reflect.TypeFor[any]()
}

// sqliteDriver is the driver modernc.org/sqlite registers, fetched once.
var sqliteDriver = sync.OnceValue(func() driver.Driver {
	db, err := sql.Open("sqlite", "")
	if err != nil {
		panic(err) // the driver is linked in by this package's import; unreachable
	}
	d := db.Driver()
	_ = db.Close()
	return d
})

// openTimed is sql.Open("sqlite", dsn) with every statement timed.
func openTimed(dsn string, log *slog.Logger) *sql.DB {
	return sql.OpenDB(&timedConnector{drv: sqliteDriver(), dsn: dsn, log: log})
}
