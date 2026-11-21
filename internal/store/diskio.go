package store

import (
	"runtime"
	"strings"
	"sync"
)

// The disk reads of each statement are counted under the code that asked
// for it (internal/diskio): "sql store.scanEventParts". Working that name
// out with callerFrame on every statement would cost a stack walk and a
// symbol lookup each time, so the program counters are walked (cheap) and
// each one is looked up once: whether it is a frame to skip (database/sql,
// this file's wrappers, the runtime) or the caller's name.

type pcKind struct {
	skip bool
	name string
}

var pcNames sync.Map // uintptr -> pcKind

func pcName(pc uintptr) pcKind {
	if v, ok := pcNames.Load(pc); ok {
		return v.(pcKind)
	}
	k := pcKind{skip: true}
	if fn := runtime.FuncForPC(pc - 1); fn != nil {
		f := fn.Name()
		if !strings.HasPrefix(f, "database/sql") && !strings.Contains(f, "internal/store.(*timed") &&
			!strings.Contains(f, "internal/store.reportSlow") && !strings.Contains(f, "internal/store.recordPlan") &&
			!strings.Contains(f, "internal/store.sqlSource") && !strings.HasPrefix(f, "runtime.") {
			k = pcKind{name: "sql " + shortFunc(f)}
		}
	}
	pcNames.Store(pc, k)
	return k
}

// sqlSource is the diskio source of the statement being run: "sql " and
// the asking function without its module path.
func sqlSource() string {
	var pcs [24]uintptr
	n := runtime.Callers(2, pcs[:])
	for _, pc := range pcs[:n] {
		if k := pcName(pc); !k.skip {
			return k.name
		}
	}
	return "sql (unknown caller)"
}

// isBegin reports whether a statement opens a transaction.
func isBegin(query string) bool {
	q := strings.TrimSpace(query)
	return len(q) >= 5 && strings.EqualFold(q[:5], "BEGIN")
}

// shortFunc is a function's name without its import path:
// "store.scanEventParts", "rollup.(*Recorder).PriceUnpriced". A closure
// keeps its enclosing function's name and drops the ".funcN" suffixes.
func shortFunc(f string) string {
	if i := strings.LastIndex(f, "/"); i >= 0 {
		f = f[i+1:]
	}
	for {
		i := strings.LastIndex(f, ".func")
		if i < 0 {
			break
		}
		rest := f[i+len(".func"):]
		if rest == "" || strings.Trim(rest, "0123456789.") != "" {
			break
		}
		f = f[:i]
	}
	return f
}
