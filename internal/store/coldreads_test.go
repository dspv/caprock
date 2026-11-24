package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"reflect"
	"sort"
	"strconv"
	"testing"
)

// agentSplitPerSession is AgentSplit as it was before it became one
// statement (2026-11-24): the grouped read, then the session's agent and its
// sidechain mark asked one session at a time. Kept here as the reference the
// one statement is held to.
func agentSplitPerSession(ctx context.Context, q Querier, from, to int64) ([]WeekAgent, error) {
	upper, args := "", []any{from}
	if to > 0 {
		upper, args = " AND ts < ?", append(args, to)
	}
	rows, err := q.QueryContext(ctx, `
		SELECT sid, (SELECT session_id FROM sessions WHERE sessions.sid = events.sid), COALESCE(agent_id,'') <> '', COUNT(*), COALESCE(SUM(cost_usd),0), COUNT(DISTINCT NULLIF(agent_id,''))
		FROM events INDEXED BY idx_events_turn_agent
		WHERE kind = 'turn.assistant' AND ts >= ?`+upper+nonInternalEvent+`
		GROUP BY sid, 3`, args...)
	if err != nil {
		return nil, err
	}
	type part struct {
		sid                      int64
		session                  string
		sub                      bool
		turns, threads, requests int64
		cost                     float64
	}
	var parts []part
	for rows.Next() {
		var p part
		if err := rows.Scan(&p.sid, &p.session, &p.sub, &p.turns, &p.cost, &p.threads); err != nil {
			_ = rows.Close()
			return nil, err
		}
		parts = append(parts, p)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	_ = rows.Close()
	usage, err := usageRows(ctx, q, from, to, "", "")
	if err != nil {
		return nil, err
	}
	for k, c := range usage {
		for i := range parts {
			if parts[i].sid == k.Sid && parts[i].sub == k.Sub {
				parts[i].turns = max(0, parts[i].turns-c.Records)
				parts[i].requests += c.Requests
				break
			}
		}
	}
	agentOf := map[string]string{}
	sidechain := map[string]bool{}
	for _, p := range parts {
		if _, ok := agentOf[p.session]; !ok {
			var agent string
			err := q.QueryRowContext(ctx, `SELECT COALESCE(agent,'claude') FROM sessions WHERE session_id = ?`, p.session).Scan(&agent)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			if agent == "" {
				agent = "claude"
			}
			agentOf[p.session] = agent
		}
		if !p.sub {
			var side sql.NullInt64
			err := q.QueryRowContext(ctx, `
				SELECT json_extract(payload, '$.sidechain') FROM events INDEXED BY idx_events_session_ts
				WHERE sid = (SELECT sid FROM sessions WHERE session_id = ?) AND kind = 'turn.assistant' AND COALESCE(agent_id,'') = '' LIMIT 1`, p.session).Scan(&side)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			sidechain[p.session] = side.Valid && side.Int64 == 1
		}
	}
	type key struct {
		agent string
		sub   bool
	}
	acc := map[key]*WeekAgent{}
	sessions := map[key]map[string]bool{}
	for _, p := range parts {
		k := key{agentOf[p.session], p.sub || sidechain[p.session]}
		a := acc[k]
		if a == nil {
			a = &WeekAgent{Agent: k.agent, Subagent: k.sub}
			acc[k] = a
			sessions[k] = map[string]bool{}
		}
		a.Turns += p.turns
		a.Requests += p.requests
		a.CostUSD += p.cost
		if k.sub {
			a.Threads += p.threads
		}
		sessions[k][p.session] = true
	}
	out := []WeekAgent{}
	for k, a := range acc {
		a.Sessions = int64(len(sessions[k]))
		out = append(out, *a)
	}
	return out, nil
}

// sortAgents orders a split for comparison; AgentSplit's own order breaks
// cost ties by name, which floating-point sums in another order may not.
func sortAgents(a []WeekAgent) {
	sort.Slice(a, func(i, j int) bool {
		if a[i].Agent != a[j].Agent {
			return a[i].Agent < a[j].Agent
		}
		return !a[i].Subagent && a[j].Subagent
	})
}

// AgentSplit asks each session's agent and sidechain mark in its one
// statement instead of two round trips per session, and its answer is the
// per-session read's, figure for figure: over random sessions of every agent
// (an empty one is Claude Code's), main threads and subagents, sessions whose
// first main-thread turn is or is not a sidechain (whatever their later turns
// say, and whether or not that turn is in the window), sessions with only
// subagent turns in the window, internal turns, and every window.
func TestAgentSplitEqualsThePerSessionRead(t *testing.T) {
	ctx := context.Background()
	st := openTest(t)
	db := st.DB()
	rng := rand.New(rand.NewSource(7))
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	agents := []string{"claude", "", "codex", "opencode", "cursor"}
	for i := range 60 {
		id := "s" + strconv.Itoa(i)
		exec(`INSERT INTO sessions(session_id, agent, status, last_event_at) VALUES(?,?,?,?)`, id, agents[rng.Intn(len(agents))], "ended", 100_000)
		turns := 1 + rng.Intn(12)
		for j := range turns {
			ts := int64(rng.Intn(100_000))
			var agentID any
			if rng.Intn(3) == 0 {
				agentID = "a" + strconv.Itoa(rng.Intn(3))
			} else if rng.Intn(4) == 0 {
				agentID = "" // an empty id is a main-thread turn
			}
			payload := `{}`
			switch rng.Intn(4) {
			case 0:
				payload = `{"sidechain":true}`
			case 1:
				payload = `{"sidechain":false}`
			}
			internal := 0
			if rng.Intn(8) == 0 {
				internal = 1
			}
			var cost any
			if rng.Intn(5) != 0 {
				cost = float64(rng.Intn(1000)) / 100
			}
			exec(`INSERT INTO events(ts, sid, source, kind, payload, agent_id, cost_usd, internal, key)
				VALUES(?,(SELECT sid FROM sessions WHERE session_id = ?),'transcript','turn.assistant',?,?,?,?,?)`,
				ts, id, payload, agentID, cost, internal, id+"-"+strconv.Itoa(j))
		}
	}
	for _, w := range [][2]int64{{0, 0}, {0, 50_000}, {25_000, 0}, {40_000, 60_000}, {99_999, 0}, {200_000, 0}} {
		got, err := AgentSplit(ctx, db, w[0], w[1])
		if err != nil {
			t.Fatal(err)
		}
		want, err := agentSplitPerSession(ctx, db, w[0], w[1])
		if err != nil {
			t.Fatal(err)
		}
		sortAgents(got)
		sortAgents(want)
		if len(got) != len(want) {
			t.Fatalf("window %v: %d groups, want %d\n got %+v\nwant %+v", w, len(got), len(want), got, want)
		}
		for i := range got {
			g, x := got[i], want[i]
			if math.Abs(g.CostUSD-x.CostUSD) > 1e-9 {
				t.Fatalf("window %v %s/%v: cost %v, want %v", w, g.Agent, g.Subagent, g.CostUSD, x.CostUSD)
			}
			g.CostUSD = x.CostUSD
			if !reflect.DeepEqual(g, x) {
				t.Fatalf("window %v: %+v, want %+v", w, g, x)
			}
		}
		if w == [2]int64{0, 0} {
			subs, sides := 0, 0
			for _, a := range got {
				if a.Subagent {
					subs++
				}
				sides += int(a.Sessions)
			}
			if subs == 0 || sides == 0 {
				t.Fatalf("the fixture has no subagent group: %+v", got)
			}
		}
	}
}

// learnMatchByTable is learnMatch's statement as it was before migration
// 0094: the calls off idx_events_tool_dist and the results off
// idx_events_sid_key, each row read from the table.
const learnMatchByTable = `
		WITH a(i, at) AS MATERIALIZED (
		  SELECT CAST(key AS INTEGER), CAST(value AS INTEGER) FROM json_each(?))
		SELECT a.i, s.session_id, MIN(e.ts)
		FROM a CROSS JOIN events p INDEXED BY idx_events_tool_dist
		JOIN sessions s ON s.sid = p.sid AND s.repo_root = ?
		JOIN events e ON e.sid = p.sid AND e.key = 'post:' || substr(p.key, 5)
		WHERE p.kind = 'tool.pre' AND p.ts >= a.at - ? AND p.ts < a.at + 1000 AND p.tool = 'Bash' AND p.internal = 0
		  AND p.key LIKE 'pre:%' AND e.ts >= a.at
		GROUP BY a.i, p.sid`

// learnRows is every row a learnMatch statement returns, as text.
func learnRows(t *testing.T, db *sql.DB, stmt string, ats []int64, root string) []string {
	t.Helper()
	js, _ := json.Marshal(ats)
	rows, err := db.QueryContext(context.Background(), stmt, string(js), root, learnLookback)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var i int
		var id string
		var end int64
		if err := rows.Scan(&i, &id, &end); err != nil {
			t.Fatal(err)
		}
		out = append(out, fmt.Sprintf("%d %s %d", i, id, end))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	sort.Strings(out)
	return out
}

// The stamps match the same calls on the two indexes of migration 0094 as on
// the table: over random Bash and other calls in two repositories, internal
// ones, calls whose result never came, results with no tool named (the
// transcript's), and stamps before, inside and after them.
func TestLearnMatchEqualsTheTableRead(t *testing.T) {
	f := newLearnFixture(t)
	rng := rand.New(rand.NewSource(11))
	for i := range 12 {
		root := "/r"
		if i%3 == 0 {
			root = "/other"
		}
		f.session("s"+strconv.Itoa(i), root, "main", 1)
	}
	tools := []string{"Bash", "Bash", "Bash", "Read", "Edit"}
	for n := range 400 {
		id := "s" + strconv.Itoa(rng.Intn(12))
		pre := int64(rng.Intn(4_000_000))
		post := pre + int64(rng.Intn(1_200_000))
		tool := tools[rng.Intn(len(tools))]
		tu := "toolu_" + strconv.Itoa(n)
		f.exec(`INSERT INTO events(ts, sid, source, kind, tool, payload, key, internal) VALUES(?,(SELECT sid FROM sessions WHERE session_id = ?),'hook','tool.pre',?,'{}',?,?)`,
			pre, id, tool, "pre:"+tu, map[bool]int{true: 1}[rng.Intn(10) == 0])
		if rng.Intn(8) == 0 {
			continue // no result yet
		}
		postTool := tool
		if rng.Intn(4) == 0 {
			postTool = "" // the transcript's result names no tool
		}
		f.exec(`INSERT INTO events(ts, sid, source, kind, tool, payload, key) VALUES(?,(SELECT sid FROM sessions WHERE session_id = ?),'transcript','tool.post',?,'{}',?)`,
			post, id, postTool, "post:"+tu)
	}
	ats := make([]int64, 300)
	for i := range ats {
		ats[i] = int64(rng.Intn(5_000_000))
	}
	db := f.st.DB()
	for _, root := range []string{"/r", "/other"} {
		got := learnRows(t, db, learnMatchSQL, ats, root)
		want := learnRows(t, db, learnMatchByTable, ats, root)
		if len(want) < 20 {
			t.Fatalf("%s: the fixture matched only %d stamps", root, len(want))
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: %d rows, want %d\n got %v\nwant %v", root, len(got), len(want), got, want)
		}
	}
}

// learnMatch reads no column of the events table: both sides are answered by
// their indexes (migration 0094). On idx_events_tool_dist every call in a
// stamp's window was fetched from the table for its sid and its key — and key
// comes after payload in the row.
func TestLearnMatchReadsNoEventRow(t *testing.T) {
	ctx := context.Background()
	db := openTest(t).DB()
	var root int64
	if err := db.QueryRowContext(ctx, `SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'events'`).Scan(&root); err != nil {
		t.Fatal(err)
	}
	rows, err := db.QueryContext(ctx, `EXPLAIN `+learnMatchSQL, "[1]", "/r", learnLookback)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	cols, _ := rows.Columns()
	onEvents := map[int64]bool{}
	opened := 0
	var reads []string
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		op := fmt.Sprint(vals[1])
		p1, _ := strconv.ParseInt(fmt.Sprint(vals[2]), 10, 64)
		p2, _ := strconv.ParseInt(fmt.Sprint(vals[3]), 10, 64)
		switch op {
		case "OpenRead":
			onEvents[p1] = p2 == root
			opened++
		case "Column":
			if onEvents[p1] {
				reads = append(reads, fmt.Sprintf("column %d", p2))
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if opened == 0 {
		t.Fatal("the program opened nothing: EXPLAIN gave no opcodes")
	}
	if len(reads) > 0 {
		t.Fatalf("learnMatch reads the events table: %v", reads)
	}
}
