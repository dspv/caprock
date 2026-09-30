// Package logcap keeps the daemon's log file from growing without bound.
//
// The daemon logs to stderr, and whoever started it decides where that goes:
// `caprock up` points it at <data_dir>/caprock.log, launchd and systemd at
// <data_dir>/service.log, a terminal at the terminal. Nothing ever trimmed
// either file. On the owner's machine caprock.log reached 4.6GB — 1.1M copies
// of one warning — before anyone looked.
//
// When stderr is a regular file past Limit, it is renamed to <name>.1
// (replacing the previous one) and a fresh file is opened and put in place of
// stdout and stderr, so the rest of the process keeps writing without knowing.
// Renaming rather than truncating does not depend on how the file was opened:
// launchd's descriptor may or may not append, and truncating a file someone
// writes to without O_APPEND leaves a hole the size of everything before.
package logcap

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"time"
)

const (
	// Limit is the size at which the log is rotated. One previous file is
	// kept, so the most a data dir ever holds is about twice this.
	Limit = 64 << 20
	// Keep is how much of the end of an old log trimIdle leaves.
	Keep = 8 << 20
	// Every is how often the size is checked.
	Every = 10 * time.Minute
)

// Run checks now and then every Every until ctx ends. A no-op when stderr is
// not a regular file (a terminal, a pipe) and on platforms that cannot swap
// a process's standard descriptors.
func Run(ctx context.Context, log *slog.Logger) {
	if !supported {
		return
	}
	t := time.NewTicker(Every)
	defer t.Stop()
	for {
		if err := rotate(Limit); err != nil && log != nil {
			log.Warn("rotate the log", "component", "logcap", "err", err)
		}
		if err := trimIdle(Limit, Keep); err != nil && log != nil {
			log.Warn("trim an old log", "component", "logcap", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// stderr is the process's; tests swap it for a file of their own.
var stderr = os.Stderr

// rotate moves stderr's file aside once it is past limit.
func rotate(limit int64) error {
	fi, err := stderr.Stat()
	if err != nil || !fi.Mode().IsRegular() || fi.Size() < limit {
		return err
	}
	path, ok := pathOf(fi)
	if !ok {
		return nil
	}
	if err := os.Rename(path, path+".1"); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	return redirect(f)
}

// trimIdle cuts down a watched log the daemon is not writing to. Only one of
// the two names is stderr at a time; the other is left over from the way the
// daemon used to be started — the owner's 4.6GB caprock.log stopped growing
// when launchd took over, and nothing would ever have shrunk it. Its last
// keep bytes are kept, from the next line on.
func trimIdle(limit, keep int64) error {
	cur, _ := stderr.Stat()
	for _, p := range candidates() {
		fi, err := os.Stat(p)
		if err != nil || !fi.Mode().IsRegular() || fi.Size() < limit {
			continue
		}
		if cur != nil && os.SameFile(fi, cur) {
			continue // the live log; rotate handles it
		}
		if err := keepTail(p, fi.Size(), keep); err != nil {
			return err
		}
	}
	return nil
}

func keepTail(path string, size, keep int64) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	buf := make([]byte, keep)
	n, err := f.ReadAt(buf, size-keep)
	_ = f.Close()
	if err != nil && n == 0 {
		return err
	}
	buf = buf[:n]
	if i := bytes.IndexByte(buf, '\n'); i >= 0 {
		buf = buf[i+1:]
	}
	tmp := path + ".trim"
	if err := os.WriteFile(tmp, buf, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
