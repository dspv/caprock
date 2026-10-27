package store

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// EnvPlanLog names a directory that receives every distinct statement this
// process runs, with its caller and first arguments: the input of the query
// plan check (`make plans`, plans_test.go). Unset, nothing is recorded.
const EnvPlanLog = "CAPROCK_PLAN_LOG"

// PlannedStatement is one line of a plan log.
type PlannedStatement struct {
	Query  string `json:"query"`
	Caller string `json:"caller"`
	Args   []any  `json:"args,omitempty"`
}

type planLog struct {
	mu   sync.Mutex
	f    *os.File
	seen map[string]bool
}

var plans = sync.OnceValue(func() *planLog {
	dir := os.Getenv(EnvPlanLog)
	if dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil
	}
	f, err := os.Create(filepath.Join(dir, fmt.Sprintf("%d-%d.jsonl", os.Getpid(), time.Now().UnixNano())))
	if err != nil {
		return nil
	}
	return &planLog{f: f, seen: map[string]bool{}}
})

func recordPlan(query string, args []driver.NamedValue) {
	p := plans()
	if p == nil {
		return
	}
	f, ok := callerFrame()
	if !ok || strings.HasSuffix(f.File, "_test.go") {
		return
	}
	key := f.Function + "\x00" + query
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.seen[key] {
		return
	}
	p.seen[key] = true
	st := PlannedStatement{Query: query, Caller: f.Function}
	for _, a := range args {
		v := a.Value
		if t, ok := v.(time.Time); ok {
			v = t.UnixMilli()
		}
		st.Args = append(st.Args, v)
	}
	b, err := json.Marshal(st)
	if err != nil {
		return
	}
	_, _ = p.f.Write(append(b, '\n'))
}

// callerFrame is the first frame outside database/sql and the timed driver:
// the code that asked for the statement.
func callerFrame() (runtime.Frame, bool) {
	pcs := make([]uintptr, 32)
	n := runtime.Callers(3, pcs)
	frames := runtime.CallersFrames(pcs[:n])
	for {
		f, more := frames.Next()
		fn := f.Function
		if !strings.HasPrefix(fn, "database/sql") && !strings.Contains(fn, "internal/store.(*timed") &&
			!strings.Contains(fn, "internal/store.reportSlow") && !strings.Contains(fn, "internal/store.recordPlan") &&
			!strings.HasPrefix(fn, "runtime.") {
			return f, true
		}
		if !more {
			return runtime.Frame{}, false
		}
	}
}
