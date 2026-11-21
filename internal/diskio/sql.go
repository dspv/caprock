package diskio

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"sync"
)

// OpenSQL is sql.Open(driverName, dsn) with every query and statement an
// operation of source name: for the other programs' databases the daemon
// reads (Cursor's, OpenCode's, Hermes's, Codex's), each one source. The
// daemon's own database counts per asking function instead
// (internal/store/slowlog.go).
func OpenSQL(name, driverName, dsn string) (*sql.DB, error) {
	drv, err := driverOf(driverName)
	if err != nil {
		return nil, err
	}
	return sql.OpenDB(&countedConnector{drv: drv, dsn: dsn, name: name}), nil
}

var drivers sync.Map // driver name -> driver.Driver

func driverOf(name string) (driver.Driver, error) {
	if d, ok := drivers.Load(name); ok {
		return d.(driver.Driver), nil
	}
	db, err := sql.Open(name, "")
	if err != nil {
		return nil, err
	}
	d := db.Driver()
	_ = db.Close()
	drivers.Store(name, d)
	return d, nil
}

type countedConnector struct {
	drv       driver.Driver
	dsn, name string
}

func (c *countedConnector) Connect(context.Context) (driver.Conn, error) {
	conn, err := c.drv.Open(c.dsn)
	if err != nil {
		return nil, err
	}
	if fc, ok := conn.(queryConn); ok {
		return &countedConn{queryConn: fc, name: c.name}, nil
	}
	return conn, nil // a driver without the context methods: uncounted
}

func (c *countedConnector) Driver() driver.Driver { return c.drv }

// queryConn is what the sqlite driver's connection implements.
type queryConn interface {
	driver.Conn
	driver.ConnBeginTx
	driver.ConnPrepareContext
	driver.ExecerContext
	driver.QueryerContext
	driver.Pinger
	driver.SessionResetter
	driver.Validator
}

type countedConn struct {
	queryConn
	name string
}

func (c *countedConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	std.begin(c.name)
	defer std.end(c.name, 0)
	return c.queryConn.ExecContext(ctx, query, args)
}

func (c *countedConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	std.begin(c.name)
	r, err := c.queryConn.QueryContext(ctx, query, args)
	if err != nil {
		std.end(c.name, 0)
		return nil, err
	}
	return &countedRows{Rows: r, name: c.name}, nil
}

// countedRows ends its operation when the result set is done.
type countedRows struct {
	driver.Rows
	name string
	done bool
}

func (r *countedRows) finish() {
	if !r.done {
		r.done = true
		std.end(r.name, 0)
	}
}

func (r *countedRows) Next(dest []driver.Value) error {
	err := r.Rows.Next(dest)
	if err != nil && !errors.Is(err, io.EOF) {
		r.finish()
	}
	return err
}

func (r *countedRows) Close() error {
	err := r.Rows.Close()
	r.finish()
	return err
}
