package store

// The summary as it was counted before it was kept per session
// (summaryparts.go): one aggregate per figure over the whole range. Kept here,
// verbatim but renamed, as the oracle the parts-based summary is checked
// against (TestPartsSummaryMatchesTheRangeQueries).

import (
	"context"
	"encoding/json"
	"sort"
	"time"
)

func legacySummarizeSparkFor(ctx context.Context, q Querier, fromMs int64, spark SparkSpec, agent AgentFilter) (Summary, error) {
	s := Summary{FromMs: fromMs}
	// One predicate, appended to every aggregate below. Computing it per query
	// would be five chances to forget one, and a forgotten filter shows the
	// other agent's money under this agent's heading.
	ev, evArgs := agent.eventScope("sid")
	evPrefixed, _ := agent.eventScope("e.sid")
	// The sessions table carries the column itself, so it needs no subquery.
	sess, sessArgs := "", []any(nil)
	if agent != "" {
		sess, sessArgs = " AND COALESCE(agent,'claude') = ?", []any{string(agent)}
	}
	// Grouping by kind runs off idx_events_kind_ts; summing CASE expressions
	// instead forced a read of every row in the range — 197ms against 81ms on a
	// 184k-event database, and this is the query behind both the Cost screen
	// and History.
	//
	// The distinct session count stays a separate query on purpose: per-kind
	// counts cannot be summed, because a session appears under several kinds
	// (it totalled 212 against a true 56 here). That query is ~10ms.
	//
	// Pinned to idx_events_ts_cover (migration 0026). With no ANALYZE statistics SQLite chose
	// idx_events_kind_id to skip the GROUP BY sort, and that walks every
	// event in the table — 0.9s for today's 772 events on the owner's
	// 300k-event database, the query the main screen polls every few seconds.
	// The covering range scan is 0.02-0.2s at every range.
	if err := sumKinds(ctx, q, fromMs, ev, evArgs, &s); err != nil {
		return s, err
	}
	// This was grouped off idx_events_session_ts as a covering index, which
	// stopped being one when `internal = 0` joined the predicate: the group
	// then read every row in the table to test it, 0.4s at every range.
	// COUNT(DISTINCT) over the ts range is 0.01-0.10s for today to 30d and
	// 0.35s for all (measured 2026-09-30 on the owner's database). The
	// history of the grouped form, kept because the numbers below are why it
	// was right at the time:
	//
	// On a real 600 MB database this query alone was 1.5s of the 1.7s that
	// Summarize took, and Summarize was 80% of `/v1/history?range=all` — the
	// endpoint the main screen polls from three components at once. Measured
	// best-of-three, warm: 0.14s → 0.02s at range=all, and no slower at today,
	// 7d or 30d, so there is no range where the old form was the better plan
	// and no reason to branch on one.
	if err := q.QueryRowContext(ctx,
		`SELECT COUNT(DISTINCT sid) FROM events INDEXED BY idx_events_ts_cover WHERE ts >= ?`+nonInternalEvent+ev, append([]any{fromMs}, evArgs...)...).Scan(&s.Sessions); err != nil {
		return s, err
	}
	// "Active" means active *now*, so it is deliberately not range-scoped — but
	// it must still be bounded in time. A session is marked active on its first
	// event and only reaped later, so during a first-run backfill this counted
	// every historical session at once: a new user's first impression was an
	// active count in the dozens that then fell to one.
	if err := q.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sessions WHERE status = 'active' AND last_event_at >= ?`+sess,
		append([]any{nowMs() - int64(activeWindow/time.Millisecond)}, sessArgs...)...).Scan(&s.Active); err != nil {
		return s, err
	}
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(model,''), COALESCE(SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)+COALESCE(cache_read,0)+COALESCE(cache_write,0)),0), COALESCE(SUM(cost_usd),0), COUNT(*), COALESCE(SUM(COALESCE(tokens_out,0)),0), COALESCE(SUM(COALESCE(cache_read,0)),0)
		FROM events WHERE kind = 'turn.assistant' AND ts >= ?`+nonInternalEvent+ev+` GROUP BY model ORDER BY 3 DESC`, append([]any{fromMs}, evArgs...)...)
	if err != nil {
		return s, err
	}
	for rows.Next() {
		var m ModelShare
		if err := rows.Scan(&m.Model, &m.Tokens, &m.CostUSD, &m.Turns, &m.Output, &m.CacheRead); err != nil {
			_ = rows.Close()
			return s, err
		}
		s.Models = append(s.Models, m)
	}
	// A truncated model list is a wrong number, not a short one: the model mix
	// is rendered as a share of the total, so a missing row silently reweights
	// every other model on the Cost screen (rule 6).
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return s, err
	}
	_ = rows.Close()
	if err := legacyDiscountUsageRecords(ctx, q, fromMs, agent, &s); err != nil {
		return s, err
	}
	// Which of those models had no price. The model mix above shows an unpriced
	// model with cost 0.00, which reads as "this model was free" rather than
	// "we could not price it" — so the volume is carried out separately and the
	// UI is able to say which model it could not price.
	if u, err := queryUnpriced(ctx, q, fromMs, agent); err != nil {
		return s, err
	} else {
		s.Unpriced = u
	}
	// Each model's own unpriced tokens, so a model priced in one chat and
	// unpriced in another carries both (ModelShare.UnpricedTokens): the
	// same turns queryUnpriced counts, by model.
	if s.Unpriced != nil {
		scope, scopeArgs := agent.eventScope("sid")
		rows, err := q.QueryContext(ctx, `
			SELECT COALESCE(model,''),
			       COALESCE(SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)+COALESCE(cache_read,0)+COALESCE(cache_write,0)),0)
			FROM events
			WHERE kind = 'turn.assistant' AND ts >= ? AND cost_usd IS NULL
			  AND (COALESCE(tokens_in,0) + COALESCE(tokens_out,0)
			       + COALESCE(cache_read,0) + COALESCE(cache_write,0)) > 0`+nonInternalEvent+scope+`
			GROUP BY model`, append([]any{fromMs}, scopeArgs...)...)
		if err != nil {
			return s, err
		}
		by := map[string]int64{}
		for rows.Next() {
			var m string
			var n int64
			if err := rows.Scan(&m, &n); err != nil {
				_ = rows.Close()
				return s, err
			}
			by[m] = n
		}
		_ = rows.Close()
		if err := rows.Err(); err != nil {
			return s, err
		}
		for i := range s.Models {
			s.Models[i].UnpricedTokens = by[s.Models[i].Model]
		}
	}
	if b, err := queryBackgroundUsage(ctx, q, fromMs, agent); err != nil {
		return s, err
	} else {
		s.Background = b
	}
	if agent == "" || agent == "hermes" {
		h, err := HermesSpend(ctx, q, fromMs)
		if err != nil {
			return s, err
		}
		s.Hermes = h
	}
	if agent == "" || agent == "cursor" {
		c, err := CursorSpend(ctx, q, fromMs)
		if err != nil {
			return s, err
		}
		s.Cursor = c
	}
	// Both levels of the projects roll-up come from ONE pass. Grouping by
	// (project, first segment of repo_path) and summing the segments back up
	// into the repository row costs a single scan; asking the database twice —
	// once per repo, once per repo+path — scanned the same events twice for a
	// breakdown that is arithmetic on the rows we already have.
	//
	// The segment is cut in SQL rather than in Go so the group-by collapses
	// `ui/src/components` and `ui/lib` into one `ui` row inside the database,
	// instead of shipping a row per distinct deep path across the driver.
	// repo_path is stored slash-separated by RepoFromCwd whatever the host's
	// separator, so this substring is not platform-dependent.
	// Rows are keyed by repo_root, not by the label. Two checkouts can share a
	// basename (`livegraph/repo` and `orch-live/repo` on the owner's machine),
	// and grouping by the label would sum them into one row — the exact bug
	// this change exists to fix, reintroduced one level up. Roots are unique by
	// construction, so grouping on them cannot collide; the labels are made
	// readable afterwards by DisambiguateLabels.
	//
	// A session outside any repository has no root, so it falls back to its
	// project label, which unrootedInfo already derives from the full path.
	// Events are aggregated per SESSION and grouped into repositories in Go.
	//
	// Grouping in SQL meant joining sessions on every one of ~90k assistant
	// events and grouping on a wide text key; grouping on the integer sid
	// alone runs off idx_events_turn_agent and needs no join and no
	// COUNT(DISTINCT) — a session's row IS one distinct session. The mapping
	// from session to (repository, segment) is then applied to tens of rows
	// instead of tens of thousands. Measured on the owner's 190k-event
	// database through the Go driver, best of six: the whole summary took
	// 210ms before this change and 204ms after, so the second grouping level
	// is free.
	//
	// When a sparkline is asked for, the SAME scan additionally groups by
	// bucket index, computed in SQL so the driver ships one row per
	// (session, bucket) that had spend rather than one row per event. On the
	// owner's database that is tens of rows becoming hundreds — still nothing —
	// while bucketing in Go would have meant selecting every assistant event's
	// timestamp and carrying ~90k rows across the driver, which is the cost this
	// query was written to avoid in the first place.
	//
	// The arithmetic is integer division on ts, not strftime: a date function
	// would have to be applied per row and could not use the index, and the
	// bucket edges are already known to the caller in unix ms.
	totals := map[string]sessionBucket{}
	// sparks[session][bucket] — only for sessions that actually spent.
	sparks := map[string][]sessionBucket{}
	sparkOn := spark.Buckets > 0 && spark.WidthMs > 0
	if sparkOn {
		// The CASE is not decoration. SQLite's integer division truncates
		// TOWARD ZERO, so an event before the grid's start gives -0 — bucket 0 —
		// and its spend would be painted onto the first column, which is spend
		// that did not happen there. That is reachable whenever the grid starts
		// after the range does. Negative offsets are mapped to -1 so the Go side
		// can reject them as "in the range, but off the picture".
		//
		// Each bucket is further split by the hour from the grid's start, so a
		// row is one session's clock hour and the burn rate's active hours
		// (Spark.ActiveHours) come from the same scan. The grid starts on a
		// local hour and its widths are whole hours, so an hour never
		// straddles two buckets. Measured on a 2.3 GB copy of the owner's
		// database, 30 days, warm: 0.032s before and 0.033s after, 109 rows
		// becoming 472, off the same covering index (2026-10-13).
		rows, err = q.QueryContext(ctx, `
			SELECT (SELECT session_id FROM sessions WHERE sessions.sid = e.sid),
			       CASE WHEN e.ts < ? THEN -1 ELSE (e.ts - ?) / ? END AS bucket,
			       CASE WHEN e.ts < ? THEN -1 ELSE (e.ts - ?) / 3600000 END AS hr,
			       COALESCE(SUM(COALESCE(e.tokens_in,0)+COALESCE(e.tokens_out,0)+COALESCE(e.cache_read,0)+COALESCE(e.cache_write,0)),0),
			       COALESCE(SUM(e.cost_usd),0),
			       COALESCE(SUM(COALESCE(e.tokens_in,0)+COALESCE(e.cache_read,0)+COALESCE(e.cache_write,0)),0),
			       COUNT(*), COUNT(e.cost_usd)
			FROM events e
			WHERE e.kind = 'turn.assistant' AND e.ts >= ?`+nonInternalEventE+evPrefixed+`
			GROUP BY e.sid, bucket, hr`,
			append([]any{spark.FromMs, spark.FromMs, spark.WidthMs, spark.FromMs, spark.FromMs, fromMs}, evArgs...)...)
	} else {
		rows, err = q.QueryContext(ctx, `
			SELECT (SELECT session_id FROM sessions WHERE sessions.sid = e.sid), 0 AS bucket, 0 AS hr,
			       COALESCE(SUM(COALESCE(e.tokens_in,0)+COALESCE(e.tokens_out,0)+COALESCE(e.cache_read,0)+COALESCE(e.cache_write,0)),0),
			       COALESCE(SUM(e.cost_usd),0), 0, 0, 0
			FROM events e
			WHERE e.kind = 'turn.assistant' AND e.ts >= ?`+nonInternalEventE+evPrefixed+`
			GROUP BY e.sid`, append([]any{fromMs}, evArgs...)...)
	}
	if err != nil {
		return s, err
	}
	for rows.Next() {
		var id string
		var b, hr, priced int64
		var t sessionBucket
		if err := rows.Scan(&id, &b, &hr, &t.tokens, &t.cost, &t.input, &t.turns, &priced); err != nil {
			_ = rows.Close()
			return s, err
		}
		// The row totals accumulate across buckets, so a repository's headline
		// number is the same whether or not a sparkline was requested. The
		// sparkline must never be able to change the figure it sits beside.
		cur := totals[id]
		cur.tokens += t.tokens
		cur.cost += t.cost
		totals[id] = cur
		if !sparkOn {
			continue
		}
		// Out-of-range buckets still count toward the total above — they are
		// spend inside `fromMs` — but have no column to be drawn in. This
		// happens when the caller's bucket grid starts after fromMs; it is not
		// an error, and silently dropping the money would understate the row.
		if b < 0 || b >= int64(spark.Buckets) {
			continue
		}
		series := sparks[id]
		if series == nil {
			series = make([]sessionBucket, spark.Buckets)
		}
		series[b].tokens += t.tokens
		series[b].cost += t.cost
		series[b].input += t.input
		series[b].turns += t.turns
		// A row is one session's hour, active by Usual's own rule, so a bar's
		// burn and the usual it is drawn against measure the same thing.
		if priced >= UsualMinCalls && t.cost > 0 {
			series[b].activeHours++
			series[b].activeCost += t.cost
		}
		sparks[id] = series
	}
	// A truncated projects list is a wrong number for the same reason a
	// truncated model list is (rule 6): the panel renders each bar as a share
	// of the largest row.
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return s, err
	}
	if err := rows.Close(); err != nil {
		return s, err
	}
	// Per-directory attribution needs spend at TURN granularity, because a turn
	// is the unit that can be charged to a directory: its cost is billed as one
	// amount, and the tools it called are what say where that amount went. The
	// two queries below are the only extra work this feature adds to the
	// summary — measured on the owner's database, see § timings in
	// migration 0012.
	turns, unlinkedCalls, err := legacyTurnSpendBySession(ctx, q, fromMs)
	if err != nil {
		return s, err
	}
	// Every repository root any session reported. Needed before the rows below
	// are walked, because a session with no root of its own is joined to a root
	// that another session reported for the same directory — and rows arrive in
	// no particular order, so deciding as we go would join or split the same
	// pair depending on which the driver happened to return first. One scan of
	// a column that has one value per session; the mapping loop below is tens
	// of rows either way.
	roots := map[string]bool{}
	rr, err := q.QueryContext(ctx,
		`SELECT DISTINCT repo_root FROM sessions WHERE repo_root IS NOT NULL AND repo_root != ''`)
	if err != nil {
		return s, err
	}
	for rr.Next() {
		var r string
		if err := rr.Scan(&r); err != nil {
			rr.Close()
			return s, err
		}
		roots[r] = true
	}
	if err := rr.Err(); err != nil {
		rr.Close()
		return s, err
	}
	rr.Close()
	// The session → repository mapping. Only sessions that actually spent in
	// the range are looked up, so a database full of old sessions costs nothing.
	rows, err = q.QueryContext(ctx,
		`SELECT session_id, COALESCE(project,''), COALESCE(repo_root,''), COALESCE(repo_path,''), COALESCE(cwd,''), COALESCE(agent,'claude') FROM sessions`+
			map[bool]string{true: " WHERE COALESCE(agent,'claude') = ?", false: ""}[agent != ""], sessArgs...)
	if err != nil {
		return s, err
	}
	defer rows.Close()
	byRoot := map[string]int{}       // grouping key → index into s.Projects
	rootLabel := map[string]string{} // grouping key → label it claims
	// pathIdx keeps one row per (repository, segment) so repeated sessions in
	// the same directory merge instead of stacking duplicate breakdown rows.
	pathIdx := map[[2]string]int{}
	for rows.Next() {
		var id, label, root, path, cwd, agent string
		if err := rows.Scan(&id, &label, &root, &path, &cwd, &agent); err != nil {
			return s, err
		}
		t, spent := totals[id]
		if !spent {
			continue // no assistant turns in this range
		}
		delete(totals, id)
		// Rows are keyed by repo_root, not by the label. Two checkouts can
		// share a basename (`livegraph/repo` and `orch-live/repo` on the
		// owner's machine), and grouping by the label would sum them into one
		// row — the exact bug this change exists to fix, one level up. Roots
		// are unique by construction; a session outside any repository falls
		// back to its label, which unrootedInfo derives from the full path.
		// A session outside any repository is identified by its own directory,
		// not by its label: /tmp/demo/testrepo and /tmp/demo2/testrepo are both
		// labelled `testrepo`, and keying on the label would sum them — the
		// original bug, one level up. The label is made unique for display by
		// DisambiguateLabels, which widens only what actually collides.
		key := root
		if key == "" {
			// A session outside any repository whose directory IS a repository
			// another session reported belongs with that one. Claude Code only
			// records repo_root when it resolves a checkout, so running once in
			// a repo and once where git could not answer split one project into
			// two rows — the second labelled with its full path, because
			// unrootedInfo derives a label from the path when there is no
			// project name to use. Same directory, same work, one row.
			if roots[cwd] {
				key = cwd
			} else {
				key = "cwd:" + cwd
			}
		}
		// With neither a repository nor a cwd there is nothing to group on but
		// the label itself. Falling through to a shared empty key would merge
		// every such session into one row.
		if key == "cwd:" {
			key = "label:" + label
		}
		i, ok := byRoot[key]
		if !ok {
			i = len(s.Projects)
			byRoot[key] = i
			rootLabel[key] = label
			dir := root
			if dir == "" {
				dir = cwd
			}
			s.Projects = append(s.Projects, ProjectShare{Project: label, Agent: agent, Dir: dir})
		}
		p := &s.Projects[i]
		// A repository worked on with both agents carries neither label.
		if p.Agent != agent {
			p.Agent = ""
		}
		p.Tokens += t.tokens
		p.CostUSD += t.cost
		// A session lives in exactly one directory, so it counts once for its
		// repository and once for its segment: the per-segment counts partition
		// the repository's sessions and add up without double-counting.
		p.Sessions++
		if sparkOn {
			addSpark(p, spark, sparks[id])
		}
		// The per-directory breakdown is charged by what the session's TURNS
		// touched, not by the directory the session was launched from. The
		// per-turn figures were gathered above; here they are folded into the
		// repository this session belongs to.
		//
		// root, not key: attribution compares a carried path against a real
		// repository root, and a session outside any repository ("cwd:…") has
		// none to compare with — its turns land in the outside row, which is
		// the honest answer for work with no repository to be inside of.
		for _, tt := range turns[id] {
			seg, _ := AttributeDir(tt.touched, root)
			pk := [2]string{key, seg}
			j, ok := pathIdx[pk]
			if !ok {
				j = len(p.Paths)
				pathIdx[pk] = j
				p.Paths = append(p.Paths, PathShare{Path: seg})
			}
			ps := &p.Paths[j]
			ps.Tokens += tt.tokens
			ps.CostUSD += tt.cost
			ps.Turns++
		}
	}
	if err := rows.Err(); err != nil {
		return s, err
	}
	// Spend whose session row has since been deleted still belongs in the
	// totals: dropping it would silently understate the bill (rule 6).
	if len(totals) > 0 {
		var orphan ProjectShare
		for id, t := range totals {
			orphan.Tokens += t.tokens
			orphan.CostUSD += t.cost
			orphan.Sessions++
			// The orphan row gets a sparkline too. Without one it would be the
			// single row whose picture disagreed with its number — a blank
			// sparkline beside real money reads as "nothing happened".
			if sparkOn {
				addSpark(&orphan, spark, sparks[id])
			}
		}
		s.Projects = append(s.Projects, orphan)
	}
	labels := DisambiguateLabels(rootLabel)
	for root, i := range byRoot {
		if l, ok := labels[root]; ok && l != "" {
			s.Projects[i].Project = l
		}
	}
	for i := range s.Projects {
		p := &s.Projects[i]
		// Drop a sentinel row that carries no money. Under carry-forward the
		// repository-wide row means only "turns before the session's first
		// touch", which for most repositories is nothing at all — and a row
		// reading $0.00 next to real directories invites the reader to wonder
		// what went wrong.
		//
		// The test is COST, not cost-and-tokens: a turn can carry tokens priced
		// at zero (an unpriced model, a cached-only turn), which still produces
		// a row rendering "$0.00" beside real spend. Directory rows are never
		// dropped — a directory in the list is there because a turn was charged
		// to it, and a real directory that genuinely cost nothing is a fact
		// about the repository rather than an artifact of the rule.
		kept := p.Paths[:0]
		for _, ps := range p.Paths {
			if (ps.Path == UnattributedPath || ps.Path == OutsidePath) && ps.CostUSD == 0 {
				continue
			}
			kept = append(kept, ps)
		}
		p.Paths = kept
		// A breakdown whose only row is a bucket says nothing the repository
		// row does not already say: "all of it, and we cannot tell you where".
		// Nor does a single directory, which would restate the row's own total
		// under a second heading.
		if len(p.Paths) < 2 {
			p.Paths = nil
			continue
		}
		for j := range p.Paths {
			ps := &p.Paths[j]
			ps.Unattributed = ps.Path == UnattributedPath
			ps.Outside = ps.Path == OutsidePath
			// The denominator is the REPOSITORY total, including the
			// unattributed bucket, so the column sums to 100% and the share
			// that could not be attributed is visible as its own percentage
			// rather than inflating the directories that could. A percentage
			// whose base the reader has to guess is exactly what rule 6 exists
			// to prevent.
			if p.Tokens > 0 {
				ps.TokensPct = 100 * float64(ps.Tokens) / float64(p.Tokens)
			}
			if p.CostUSD > 0 {
				ps.CostPct = 100 * ps.CostUSD / p.CostUSD
			}
		}
		// Sorted by cost, except that the two rows which are NOT directories are
		// pinned last however large they are: they do not compete with the
		// directories for "which service costs most", and a reader scanning for
		// the costliest service should not have to skip past them. Outside sits
		// above repository-wide, since it is the larger and more informative of
		// the two on real data.
		rank := func(ps PathShare) int {
			switch ps.Path {
			case OutsidePath:
				return 1
			case UnattributedPath:
				return 2
			}
			return 0
		}
		sort.SliceStable(p.Paths, func(a, b int) bool {
			if ra, rb := rank(p.Paths[a]), rank(p.Paths[b]); ra != rb {
				return ra < rb
			}
			return p.Paths[a].CostUSD > p.Paths[b].CostUSD
		})
	}
	// Rolling the segments up changed the repository totals, so any ORDER BY
	// the database applied would have been over segments, not repositories.
	sort.SliceStable(s.Projects, func(a, b int) bool { return s.Projects[a].CostUSD > s.Projects[b].CostUSD })

	// What the money was spent ON. This is the third cut of the same question
	// the model mix and the project list answer, and it shares their rule: a
	// turn's cost goes whole to one row, so the rows sum exactly to the total.
	work, unlinked := legacyWorkSpend(turns, unlinkedCalls)
	s.Work, s.WorkUnlinkedCalls = work, unlinked
	// The denominators are the RANGE totals, so each column sums to 100%. They
	// are taken from the rows themselves rather than from s.CostUSD/s.Tokens*:
	// the summary's headline totals sum every event kind (so a future priced
	// event type is not dropped), while these rows cover assistant turns only.
	// Dividing one by the other would produce percentages that do not reach
	// 100% and could not be checked against the rows shown.
	var workCost float64
	var workTokens int64
	for _, w := range s.Work {
		workCost += w.CostUSD
		workTokens += w.Tokens
	}
	for i := range s.Work {
		w := &s.Work[i]
		if workTokens > 0 {
			w.TokensPct = 100 * float64(w.Tokens) / float64(workTokens)
		}
		if workCost > 0 {
			w.CostPct = 100 * w.CostUSD / workCost
		}
	}
	return s, nil
}

// turnSpendBySession returns, per session, one entry per assistant turn in the
// range: what it cost and which directory was carried into it.
//
// ONE ORDERED SCAN, NOT A JOIN. Carry-forward is inherently sequential — a
// turn's directory is a function of everything before it in its session — so
// the tool calls and the turns are read TOGETHER in event order and the carry
// is threaded through them in Go. This replaces the two independent queries the
// strict rule used (a per-turn touch lookup plus a turn scan).
//
// Doing the carry in SQL was considered and rejected. A window function could
// compute `last_value(touch_dir) IGNORE NULLS OVER (PARTITION BY sid
// ORDER BY ts, id)`, but deciding whether the carried directory is inside the
// repository needs the same path normalization the ingest path uses — folding
// separators so a Windows-captured session groups with the same repository read
// anywhere else. Re-implementing that in SQL would put a second, silently
// diverging definition in a second language, the exact trap migration 0012
// documents for the dirname cut. The scan is O(n) in one pass either way.
//
// WHY msg_id NO LONGER GATES ATTRIBUTION. Under the strict rule a tool call
// without a message id could not be billed to a turn, so its whole session was
// forced unattributed. Carry-forward does not need the linkage: it places a
// turn by WHEN a touch happened relative to it, not by which message the touch
// belonged to. A hook-plane tool call carries no msg_id but does carry a
// timestamp, which is all the carry needs — so those sessions now attribute
// normally instead of collapsing into one bucket.
//
// COST IS READ, NOT RECOMPUTED. cost_usd on turn.assistant is the priced figure
// the rest of the dashboard reports; deriving a second number here would give
// the panel two totals for one repository.
//
// INDEXED BY is not a micro-optimization. Without stats — and nothing in the
// daemon runs ANALYZE, so no user database has them — SQLite prefers
// idx_events_kind_ts for the `kind IN (…)` predicate and sorts 90271 rows in a
// temp B-tree: ~290 ms, against a ~250 ms budget for the whole summary. Pinning
// idx_events_attr makes the plan a covering scan in index order with no sort,
// measured at ~93 ms on the owner's database (2026-08-22, 30d, Go driver).
//
// The index leads on sid, so `ts >= ?` alone could not seek: every
// range scanned the whole index, all of history, to keep the rows in range —
// 41 ms for ten minutes on a 517,000-event copy of the owner's database
// (2026-10-14), and today's summary is counted again every two seconds while
// anything is written. The sessions with rows in range come first, off
// idx_events_ts_cover, and each is then a seek on (sid, ts>=); the IN
// list is walked in order, so the scan still needs no sort. Only for ranges
// within seekSessionsWithin.
//
// It also returns how many tool calls in the range carried no message id and so
// could not be attached to any turn — the honest upper bound on how much of the
// work-kind breakdown's "no tool" row is really unlinked work (see workkind.go).
func legacyTurnSpendBySession(ctx context.Context, q Querier, fromMs int64) (map[string][]turnSpend, int64, error) {
	// msg_id and tool ride along for the WORK-KIND breakdown, which needs
	// exactly the rows this scan already reads (see workkind.go). Folding it in
	// here rather than running a second aggregate is what keeps it free: the
	// index covers every column below, so the plan stays a covering scan in
	// index order with no sort and no table access.
	// inner_tool, when set, is the tool a Codex `exec` script really ran
	// (migration 0038) and classifies the call in place of `exec`.
	inRange, args := "sid IS NOT NULL", []any{fromMs}
	if nowMs()-fromMs <= seekSessionsWithin.Milliseconds() {
		inRange = `sid IN (
		        SELECT DISTINCT sid FROM events INDEXED BY idx_events_ts_cover
		         WHERE ts >= ? AND internal = 0 AND kind IN ('tool.pre', 'turn.assistant'))`
		args = []any{fromMs, fromMs}
	}
	rows, err := q.QueryContext(ctx, `
		SELECT sid, kind, COALESCE(touch_dir, ''), COALESCE(msg_id,''), COALESCE(inner_tool, tool, ''),
		       COALESCE(tokens_in,0)+COALESCE(tokens_out,0)+COALESCE(cache_read,0)+COALESCE(cache_write,0),
		       COALESCE(cost_usd,0)
		FROM events INDEXED BY idx_events_attr_work
		WHERE `+inRange+` AND ts >= ?
		  AND internal = 0
		  AND kind IN ('tool.pre', 'turn.assistant')
		ORDER BY sid, ts, id`, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := map[int64][]turnSpend{}
	// Tool calls in range with no message id: they exist, they were paid for,
	// and nothing says which turn paid. Counted so the breakdown can state its
	// own uncertainty instead of presenting it as absence of tool use.
	var unlinkedCalls int64
	// The work kind of each turn, keyed by its message id. A turn is classified
	// by its OWN tool calls, so this is a plain grouping rather than a carry —
	// see workkind.go for why work kind must not carry forward the way a
	// directory does.
	//
	// The key is the bare message id, not (session, message id): the scan is
	// ordered by session, so the map is CLEARED on every session change and can
	// never be consulted across one. That keeps a string concatenation out of
	// the hot path — this loop runs once per tool call on the whole range.
	kinds := map[string]WorkKind{}
	// The carry, valid only within the session named by carrySess. Resetting it
	// on every session change is what keeps attribution from crossing session
	// boundaries — one piece of work must never be charged to another's
	// directory, and the scan's ORDER BY groups sessions so a single variable
	// suffices.
	var carrySess int64
	var carryDir string
	var carried bool
	for rows.Next() {
		var sess, tokens int64
		var kind, dir, msg, tool string
		var cost float64
		if err := rows.Scan(&sess, &kind, &dir, &msg, &tool, &tokens, &cost); err != nil {
			return nil, 0, err
		}
		if sess != carrySess {
			// Resolve the OUTGOING session's turns before its message ids are
			// forgotten. A turn's row is written BEFORE the tool_use blocks of
			// the same message (they arrive on a later transcript line), so a
			// turn's own tool calls are still ahead of it when its row is read
			// — the kinds cannot be applied until the session is complete.
			// carrySess still names the outgoing session at this point.
			resolveWork(out[carrySess], kinds)
			clear(kinds)
			carrySess, carryDir, carried = sess, "", false
		}
		if kind == "tool.pre" {
			// The work kind of the TURN this call belongs to, keyed by the
			// message id that links them. A call with no message id cannot be
			// attached to any turn and is counted rather than guessed at —
			// that count is Summary.WorkUnlinkedCalls.
			if msg == "" {
				unlinkedCalls++
			} else {
				k := workKindOf(tool)
				if cur, seen := kinds[msg]; !seen || workKindRank(k) < workKindRank(cur) {
					kinds[msg] = k
				}
			}
			// Only a tool that named a file moves the carry. A pathless call
			// (Bash, Grep) leaves touch_dir NULL and must NOT clear it — the
			// commands between two edits are part of the same stretch of work,
			// which is the whole point of the rule.
			if dir != "" {
				carryDir, carried = dir, true
			}
			continue
		}
		ts := turnSpend{
			tokens:  tokens,
			cost:    cost,
			touched: TouchDirs{Dir: carryDir, HasDir: carried},
			msgKey:  msg,
			hasMsg:  msg != "",
		}
		out[sess] = append(out[sess], ts)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	// The final session has no successor to trigger its resolution.
	resolveWork(out[carrySess], kinds)
	bySession, err := legacySessionIDsOf(ctx, q, out)
	return bySession, unlinkedCalls, err
}

// discountUsageRecords takes the usage records out of a summary's turn
// counts and puts Cursor's request counts on its models.
func legacyDiscountUsageRecords(ctx context.Context, q Querier, fromMs int64, agent AgentFilter, s *Summary) error {
	u, err := usageRows(ctx, q, fromMs, 0, "", agent)
	if err != nil || len(u) == 0 {
		return err
	}
	by := usageByModel(u)
	for i := range s.Models {
		c, ok := by[s.Models[i].Model]
		if !ok {
			continue
		}
		s.Models[i].Turns = max(0, s.Models[i].Turns-c.Records)
		if c.Requests > 0 {
			s.Models[i].Requests = c.Requests
			s.Models[i].RequestsCostUSD = c.CostUSD
		}
		s.Turns = max(0, s.Turns-c.Records)
	}
	return nil
}

// legacySessionIDsOf rekeys a long scan's results from sid to session id. Naming the
// session on every row instead took 0.28 s against 0.12 s for 355k events
// (2026-10-19).
func legacySessionIDsOf[V any](ctx context.Context, q Querier, bySid map[int64]V) (map[string]V, error) {
	out := make(map[string]V, len(bySid))
	if len(bySid) == 0 {
		return out, nil
	}
	sids := make([]int64, 0, len(bySid))
	for sid := range bySid {
		sids = append(sids, sid)
	}
	list, err := json.Marshal(sids)
	if err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT sid, session_id FROM sessions WHERE sid IN (SELECT value FROM json_each(?))`, string(list))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var sid int64
		var id string
		if err := rows.Scan(&sid, &id); err != nil {
			return nil, err
		}
		out[id] = bySid[sid]
	}
	return out, rows.Err()
}

func legacyWorkSpend(turns map[string][]turnSpend, unlinkedCalls int64) ([]WorkShare, int64) {
	byKind := map[WorkKind]*WorkShare{}
	for _, spends := range turns {
		for _, t := range spends {
			k := WorkNone
			if t.hasWork {
				k = t.work
			}
			w := byKind[k]
			if w == nil {
				w = &WorkShare{Kind: k}
				byKind[k] = w
			}
			w.Turns++
			w.Tokens += t.tokens
			w.CostUSD += t.cost
		}
	}
	return orderWork(byKind), unlinkedCalls
}
