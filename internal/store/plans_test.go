package store

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"
)

const (
	plansGolden = "testdata/query-plans.txt"
	// envPlansFrom names the directory a `go test ./...` run recorded into
	// (EnvPlanLog); envPlansUpdate rewrites the golden file from it.
	envPlansFrom   = "CAPROCK_PLANS_FROM"
	envPlansUpdate = "CAPROCK_PLANS_UPDATE"
)

// scanAllowed is every caller whose statement may read every row of events,
// and why.
var scanAllowed = map[string]string{
	"store.eventBreakdown":     "the storage measurement sizes every row, once, on request",
	"store.CountEvents":        "the status figure counts every event, and its callers cache it",
	"store.turnSpendBySession": "past seekSessionsWithin the whole index is cheaper than a seek per session",
}

// Every statement the test suite runs outside test files keeps the plan in
// testdata/query-plans.txt, and none reads all of events unless scanAllowed
// says why. With no ANALYZE statistics, SQLite plans the same on an empty
// database as on a user's, so a lost index shows here (#675, #676).
func TestQueryPlans(t *testing.T) {
	dir := os.Getenv(envPlansFrom)
	if dir == "" {
		t.Skip("make plans records the statements first")
	}
	stmts, err := readPlanLogs(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(stmts) < 100 {
		t.Fatalf("only %d statements recorded in %s", len(stmts), dir)
	}
	ctx := context.Background()
	st, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	// The tables migration 0073's move reads exist only while it runs; the
	// temporary one lives on a single connection.
	st.DB().SetMaxOpenConns(1)
	for _, q := range []string{
		`CREATE TABLE events_legacy (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL,
			source TEXT NOT NULL, kind TEXT NOT NULL, tool TEXT, payload TEXT NOT NULL, tokens_in INTEGER,
			tokens_out INTEGER, cache_read INTEGER, cache_write INTEGER, cost_usd REAL, key TEXT, model TEXT,
			cache_write_1h INTEGER, agent_id TEXT, msg_id TEXT, touch_dir TEXT, tool_bytes INTEGER NOT NULL DEFAULT 0,
			internal INTEGER NOT NULL DEFAULT 0, inner_tool TEXT)`,
		`CREATE UNIQUE INDEX idx_events_session_key ON events_legacy(session_id, key) WHERE key IS NOT NULL`,
		`CREATE TEMP TABLE events_moving AS SELECT * FROM events_legacy WHERE false`,
	} {
		if _, err := st.DB().ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}

	var b strings.Builder
	b.WriteString("# Written by `make plans`: each statement `go test ./...` runs outside test\n" +
		"# files, its callers, and its plan on an empty database at the latest schema.\n")
	for _, s := range stmts {
		plan, err := explain(ctx, st, s)
		fmt.Fprintf(&b, "\n## %s\n%s\n", strings.Join(s.callers, ", "), s.query)
		if err != nil {
			fmt.Fprintf(&b, "    (not explained: %v)\n", err)
			continue
		}
		b.WriteString(plan)
		for _, line := range strings.Split(plan, "\n") {
			if scansEvents(strings.TrimSpace(line), s.query) && !slices.ContainsFunc(s.callers, isScanAllowed) {
				t.Errorf("reads every row of events: %s\n  %s\n  called from %s", strings.TrimSpace(line), s.query, strings.Join(s.callers, ", "))
			}
		}
	}
	got := b.String()

	if os.Getenv(envPlansUpdate) != "" {
		if err := os.WriteFile(plansGolden, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(plansGolden)
	if err != nil {
		t.Fatal(err)
	}
	if d := planDiff(string(want), got); d != "" {
		t.Errorf("query plans differ from %s; check them and run `make plans` to update it:\n%s", plansGolden, d)
	}
}

type plannedQuery struct {
	query   string
	callers []string
	args    []any
}

// readPlanLogs reads every log in dir and keeps each distinct statement once,
// with all its callers. Schema changes, transaction control and the
// migrations are not plans.
func readPlanLogs(dir string) ([]plannedQuery, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if err != nil {
		return nil, err
	}
	byQuery := map[string]*plannedQuery{}
	for _, name := range files {
		f, err := os.Open(name)
		if err != nil {
			return nil, err
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(nil, 16<<20)
		for sc.Scan() {
			var p PlannedStatement
			dec := json.NewDecoder(strings.NewReader(sc.Text()))
			dec.UseNumber()
			if err := dec.Decode(&p); err != nil {
				_ = f.Close()
				return nil, fmt.Errorf("%s: %w", name, err)
			}
			q := tempLiteral.ReplaceAllLiteralString(oneLineSQL(stripComments(p.Query)), "'<temp>'")
			if !explainable(q) || strings.HasSuffix(p.Caller, ".migrate") {
				continue
			}
			caller := strings.TrimPrefix(p.Caller, "github.com/dspv/caprock/internal/")
			pq := byQuery[q]
			if pq == nil {
				pq = &plannedQuery{query: q, args: numbersToGo(p.Args)}
				byQuery[q] = pq
			}
			if !slices.Contains(pq.callers, caller) {
				pq.callers = append(pq.callers, caller)
			}
		}
		_ = f.Close()
		if err := sc.Err(); err != nil {
			return nil, err
		}
	}
	out := make([]plannedQuery, 0, len(byQuery))
	for _, pq := range byQuery {
		sort.Strings(pq.callers)
		out = append(out, *pq)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].callers[0] != out[j].callers[0] {
			return out[i].callers[0] < out[j].callers[0]
		}
		return out[i].query < out[j].query
	})
	return out, nil
}

// stripComments drops `--` comments, which would swallow the rest of a
// statement put on one line. Quoted text is kept as it is.
func stripComments(q string) string {
	var b strings.Builder
	quoted := false
	for i := 0; i < len(q); i++ {
		switch {
		case q[i] == '\'':
			quoted = !quoted
		case !quoted && strings.HasPrefix(q[i:], "--"):
			for i < len(q) && q[i] != '\n' {
				i++
			}
		}
		if i < len(q) {
			b.WriteByte(q[i])
		}
	}
	return b.String()
}

// tempLiteral is a quoted path in the temporary directory, which the week's
// hand-run filter writes into its statement: a new one every run, on every OS.
var tempLiteral = regexp.MustCompile(`'` + regexp.QuoteMeta(strings.TrimRight(os.TempDir(), `/\`)) + `[^']*'`)

var notPlanned = regexp.MustCompile(`(?i)^(?:--[^\n]*\s*)*(?:PRAGMA|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|CREATE|DROP|ALTER|VACUUM|ANALYZE|ATTACH|DETACH|REINDEX)\b`)

func explainable(q string) bool { return q != "" && !notPlanned.MatchString(q) }

func numbersToGo(args []any) []any {
	for i, a := range args {
		if n, ok := a.(json.Number); ok {
			if v, err := n.Int64(); err == nil {
				args[i] = v
			} else if v, err := n.Float64(); err == nil {
				args[i] = v
			}
		}
	}
	return args
}

// explain renders a statement's plan as an indented tree, one step a line.
func explain(ctx context.Context, st *Store, s plannedQuery) (string, error) {
	rows, err := st.DB().QueryContext(ctx, "EXPLAIN QUERY PLAN "+s.query, s.args...)
	if err != nil {
		return "", err
	}
	defer func() { _ = rows.Close() }()
	depth := map[int]int{0: 0}
	var b strings.Builder
	for rows.Next() {
		var id, parent, notused int
		var detail string
		if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
			return "", err
		}
		depth[id] = depth[parent] + 1
		fmt.Fprintf(&b, "%s%s\n", strings.Repeat("    ", depth[id]), detail)
	}
	return b.String(), rows.Err()
}

var eventsAlias = regexp.MustCompile(`(?i)\bevents\s+(?:AS\s+)?([a-z_][a-z0-9_]*)`)

// scansEvents is a plan step that reads every row of the events table, or of
// one of its indexes, under its own name or the alias the statement gave it.
func scansEvents(step, query string) bool {
	rest, ok := strings.CutPrefix(step, "SCAN ")
	if !ok {
		return false
	}
	name, _, _ := strings.Cut(rest, " ")
	if name == "events" {
		return true
	}
	for _, m := range eventsAlias.FindAllStringSubmatch(query, -1) {
		if strings.EqualFold(m[1], name) && !sqlKeyword[strings.ToUpper(m[1])] {
			return true
		}
	}
	return false
}

var sqlKeyword = map[string]bool{
	"WHERE": true, "JOIN": true, "LEFT": true, "INNER": true, "CROSS": true, "ON": true, "USING": true,
	"INDEXED": true, "NOT": true, "GROUP": true, "ORDER": true, "LIMIT": true, "UNION": true,
	"EXCEPT": true, "INTERSECT": true, "SET": true, "VALUES": true, "WINDOW": true, "RETURNING": true,
}

func isScanAllowed(caller string) bool { _, ok := scanAllowed[caller]; return ok }

// planDiff names each statement whose plan changed, appeared or went away.
func planDiff(want, got string) string {
	w, g := planBlocks(want), planBlocks(got)
	var out []string
	for q, gp := range g {
		switch wp, ok := w[q]; {
		case !ok:
			out = append(out, "+ "+q+"\n"+gp)
		case wp != gp:
			out = append(out, "~ "+q+"\n  was:\n"+wp+"  now:\n"+gp)
		}
	}
	for q := range w {
		if _, ok := g[q]; !ok {
			out = append(out, "- "+q)
		}
	}
	sort.Strings(out)
	return strings.Join(out, "\n")
}

// planBlocks maps each statement in a plans file to its plan lines.
func planBlocks(s string) map[string]string {
	m := map[string]string{}
	for _, block := range strings.Split(s, "\n## ")[1:] {
		lines := strings.SplitN(block, "\n", 3)
		if len(lines) < 2 {
			continue
		}
		plan := ""
		if len(lines) == 3 {
			plan = lines[2]
		}
		m[lines[1]] = strings.TrimRight(plan, "\n") + "\n"
	}
	return m
}
