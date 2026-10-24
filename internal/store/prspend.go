package store

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// The PRs & CI board's "agent cost" and the Now screen's cost per pull
// request (owner, 2026-10-14, translated: "a team lead wants to understand
// where the money for tokens goes, how much each PR costs"). Caprock knows a
// pull request's agent work two ways, and a session is charged through one of
// them only, so the per-PR figures add up to what the sessions cost and never
// more (rule 6):
//
//   - Its head branch. A session recorded on the branch (sessions.git_branch)
//     is charged to that branch's pull request whole — unless it opened or
//     merged more than one pull request (session_prs). sessions.git_branch is
//     the branch the session was on last, so a long session that drives
//     many pull requests and ends on a release branch was charged whole to
//     the release's pull request (owner, 2026-10-14: #601, the release, read
//     as the session's entire spend). Such a session is cut as below.
//   - The sessions that worked on it (session_prs: a session that opened,
//     pushed to or merged it). A session not on such a branch is cut at the
//     moments it opened its pull requests — each one, ordered by when it was
//     opened (else last touched), is charged the session's spend since the
//     one before, and the newest also everything after, its fix-ups. A
//     session with one pull request is charged to it whole. A pull request
//     charged a cut says so (PRSpend.Shared).
//
// All at API list price, as every cost in Caprock is (session_stats.cost_usd,
// events.cost_usd).

// PRRef names a pull request for SpendByPR: its link and head branch.
type PRRef struct {
	URL    string
	Branch string
}

// PRSpend is the agent work Caprock recorded for one pull request.
type PRSpend struct {
	CostUSD float64 `json:"cost_usd"`
	// Sessions counts the sessions charged to it; Live those of them not
	// ended — for a session cut between several, only the newest one's.
	Sessions int      `json:"sessions"`
	Live     int      `json:"live"`
	Agents   []string `json:"agents"`
	// ByBranch and BySlice say through which way the cost came: the
	// sessions on the head branch, and those cut at their pull requests.
	ByBranch float64 `json:"by_branch"`
	BySlice  float64 `json:"by_slice"`
	// Shared counts the sessions charged to it only in part: each worked on
	// other pull requests too and was cut between them.
	Shared int `json:"shared,omitempty"`
	// The tokens of the same work: input, output, cache reads and writes.
	TokensIn   int64 `json:"tokens_in"`
	TokensOut  int64 `json:"tokens_out"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
}

// prTokens is a piece of work's tokens.
type prTokens struct{ in, out, read, write int64 }

type prSession struct {
	branch, status, agent string
	cost                  float64
	tok                   prTokens
	rows                  []prRow
	sums                  []prSum // per row, for a session cut between several
}

type prRow struct {
	url    string
	anchor int64
}

// SpendByPR charges the sessions of repository repoRoot to the pull
// requests prs, keyed by URL. Where two of prs share a head branch, the
// first in prs owns it: pass the open one first, then the newest. Three
// small reads: the repository's sessions with a branch (through
// idx_sessions_repo_branch), the session_prs rows of the sessions that
// worked on one of prs, and, for a session cut between several, one sum per
// slice over its events (through its (sid, ts) index).
func SpendByPR(ctx context.Context, q Querier, repoRoot string, prs []PRRef) (map[string]PRSpend, error) {
	out := map[string]PRSpend{}
	if len(prs) == 0 {
		return out, nil
	}
	want := map[string]bool{}
	owner := map[string]string{} // branch -> URL
	for _, p := range prs {
		want[p.URL] = true
		if p.Branch != "" && owner[p.Branch] == "" {
			owner[p.Branch] = p.URL
		}
	}
	agents := map[string]map[string]bool{}
	add := func(url, agent string, cost float64, tok prTokens, live, branch, shared bool) {
		s := out[url]
		s.CostUSD += cost
		s.TokensIn += tok.in
		s.TokensOut += tok.out
		s.CacheRead += tok.read
		s.CacheWrite += tok.write
		if branch {
			s.ByBranch += cost
		} else {
			s.BySlice += cost
		}
		if shared {
			s.Shared++
		}
		s.Sessions++
		if live {
			s.Live++
		}
		if agents[url] == nil {
			agents[url] = map[string]bool{}
		}
		agents[url][agent] = true
		out[url] = s
	}

	// The head branches' sessions, charged whole.
	onBranch := map[string]bool{}
	if repoRoot != "" && len(owner) > 0 {
		rows, err := q.QueryContext(ctx, `
			SELECT s.session_id, s.git_branch, s.status, COALESCE(NULLIF(s.agent,''),'claude'), COALESCE(st.cost_usd,0),
			       COALESCE(st.tokens_in,0), COALESCE(st.tokens_out,0), COALESCE(st.cache_read,0), COALESCE(st.cache_write,0),
			       (SELECT COUNT(*) FROM session_prs q WHERE q.session_id = s.session_id AND (q.opened_at > 0 OR q.merged_at > 0))
			FROM sessions s
			LEFT JOIN session_stats st ON st.session_id = s.session_id
			WHERE s.repo_root = ? AND s.git_branch IS NOT NULL AND s.git_branch <> ''`, repoRoot)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, branch, status, agent string
			var cost float64
			var tok prTokens
			var driven int
			if err := rows.Scan(&id, &branch, &status, &agent, &cost, &tok.in, &tok.out, &tok.read, &tok.write, &driven); err != nil {
				rows.Close()
				return nil, err
			}
			// A session that opened or merged several pull requests is cut
			// between them below, whatever branch it ended on.
			if u := owner[branch]; u != "" && driven <= 1 {
				onBranch[id] = true
				add(u, agent, cost, tok, status != "ended", true, false)
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}

	// The sessions that worked on one of them, with every pull request each
	// recorded (their cuts need all of them, this repository's or not).
	args := make([]any, 0, len(want))
	for u := range want {
		args = append(args, u)
	}
	rows, err := q.QueryContext(ctx, `
		SELECT p.session_id, p.url, CASE WHEN p.opened_at > 0 THEN p.opened_at ELSE p.last_at END,
		       COALESCE(s.git_branch,''), s.status, COALESCE(NULLIF(s.agent,''),'claude'), COALESCE(st.cost_usd,0),
		       COALESCE(st.tokens_in,0), COALESCE(st.tokens_out,0), COALESCE(st.cache_read,0), COALESCE(st.cache_write,0)
		FROM session_prs p
		JOIN sessions s ON s.session_id = p.session_id
		LEFT JOIN session_stats st ON st.session_id = p.session_id
		WHERE p.session_id IN (SELECT session_id FROM session_prs WHERE url IN (?`+strings.Repeat(",?", len(args)-1)+`))`, args...)
	if err != nil {
		return nil, err
	}
	sessions := map[string]*prSession{}
	var order []string
	for rows.Next() {
		var id string
		var r prRow
		var x prSession
		if err := rows.Scan(&id, &r.url, &r.anchor, &x.branch, &x.status, &x.agent, &x.cost, &x.tok.in, &x.tok.out, &x.tok.read, &x.tok.write); err != nil {
			rows.Close()
			return nil, err
		}
		if onBranch[id] {
			continue
		}
		s := sessions[id]
		if s == nil {
			s = &x
			sessions[id] = s
			order = append(order, id)
		}
		s.rows = append(s.rows, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	// The slices of the sessions cut between several, all summed in one
	// read. An ended session's are kept (sliceMemo): its events no longer
	// change, and summing them again was most of the cost.
	var slices []prSlice
	var memoize []string
	for _, id := range order {
		s := sessions[id]
		sort.SliceStable(s.rows, func(a, b int) bool { return s.rows[a].anchor < s.rows[b].anchor })
		if len(s.rows) == 1 {
			continue
		}
		ended := s.status == "ended"
		var have []bool
		if ended {
			s.sums, have = sliceMemo.get(memoKey(q, id), s.fingerprint(), len(s.rows))
		} else {
			s.sums = make([]prSum, len(s.rows))
		}
		added := false
		for i, r := range s.rows {
			if !want[r.url] || (have != nil && have[i]) {
				continue
			}
			lo := int64(-1)
			if i > 0 {
				lo = s.rows[i-1].anchor
			}
			hi := int64(1) << 62
			if i < len(s.rows)-1 {
				hi = r.anchor
			}
			slices = append(slices, prSlice{session: id, lo: lo, hi: hi, sum: &s.sums[i], row: i})
			added = true
		}
		if ended && added {
			memoize = append(memoize, id)
		}
	}
	if err := sliceSums(ctx, q, slices); err != nil {
		return nil, err
	}
	if len(memoize) > 0 {
		done := map[string][]int{}
		for _, sl := range slices {
			done[sl.session] = append(done[sl.session], sl.row)
		}
		for _, id := range memoize {
			s := sessions[id]
			sliceMemo.put(memoKey(q, id), s.fingerprint(), s.sums, done[id])
		}
	}
	for _, id := range order {
		s := sessions[id]
		live := s.status != "ended"
		if len(s.rows) == 1 {
			add(s.rows[0].url, s.agent, s.cost, s.tok, live, false, false)
			continue
		}
		for i, r := range s.rows {
			if !want[r.url] {
				continue
			}
			if s.sums[i].cost == 0 && i < len(s.rows)-1 {
				continue
			}
			add(r.url, s.agent, s.sums[i].cost, s.sums[i].tok, live && i == len(s.rows)-1, false, true)
		}
	}
	for u, s := range out {
		s.Agents = make([]string, 0, len(agents[u]))
		for a := range agents[u] {
			s.Agents = append(s.Agents, a)
		}
		sort.Strings(s.Agents)
		out[u] = s
	}
	return out, nil
}

// sliceMemo keeps the slice sums of ended sessions, per database and
// session: summing them again on every board and Most expensive read was
// 190 ms warm for every pull request of the owner's repository
// (2026-10-23), 13 sessions and 380,000 events. A session's fingerprint —
// its recorded total and tokens, and its pull requests' moments — must
// match, so one that resumed, was tailed further or recorded another pull
// request is summed afresh.
var sliceMemo = &memoSums{m: map[string]memoEntry{}}

// sliceMemoMax bounds the sessions kept; past it the memo starts over.
const sliceMemoMax = 1024

type memoSums struct {
	mu sync.Mutex
	m  map[string]memoEntry
}

type memoEntry struct {
	fp   string
	sums []prSum
	have []bool // which slices are summed: only the ones asked for are
}

// get is a session's kept slices when its fingerprint still matches: the
// sums and which of them are summed, each n long; zeroes and none otherwise.
func (c *memoSums) get(key, fp string, n int) ([]prSum, []bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	sums, have := make([]prSum, n), make([]bool, n)
	if e, ok := c.m[key]; ok && e.fp == fp && len(e.sums) == n {
		copy(sums, e.sums)
		copy(have, e.have)
	}
	return sums, have
}

func (c *memoSums) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m = map[string]memoEntry{}
}

// put keeps the slices rows of sums, beside those already kept for the
// same fingerprint.
func (c *memoSums) put(key, fp string, sums []prSum, rows []int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[key]
	if !ok || e.fp != fp || len(e.sums) != len(sums) {
		if !ok && len(c.m) >= sliceMemoMax {
			c.m = map[string]memoEntry{}
		}
		e = memoEntry{fp: fp, sums: make([]prSum, len(sums)), have: make([]bool, len(sums))}
	}
	for _, i := range rows {
		e.sums[i], e.have[i] = sums[i], true
	}
	c.m[key] = e
}

// memoKey names a session within one database (tests' in-memory ones reuse
// session ids).
func memoKey(q Querier, id string) string { return fmt.Sprintf("%p|%s", q, id) }

// fingerprint is what a session's slices rest on: its status, total and
// tokens, and its pull requests' moments in order.
func (s *prSession) fingerprint() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s|%v|%d,%d,%d,%d", s.status, s.cost, s.tok.in, s.tok.out, s.tok.read, s.tok.write)
	for _, r := range s.rows {
		fmt.Fprintf(&b, "|%d %s", r.anchor, r.url)
	}
	return b.String()
}

// prSlice is one slice of a session cut between its pull requests: its
// events after lo up to and including hi.
type prSlice struct {
	session string
	lo, hi  int64
	sum     *prSum
	row     int // its pull request's place in the session's rows
}

type prSum struct {
	cost float64
	tok  prTokens
}

// sliceSums sums every slice in one statement, so in one read transaction:
// a query per slice spent most of its time taking and dropping the WAL read
// lock (665 of them, 190–250 ms warm, for every pull request of the owner's
// repository, 2026-10-23). The slices go in as one JSON array; each is two
// ranges of idx_events_attr_work, which carries every column summed — one
// joined GROUP BY sorted every event row instead and was slower still.
func sliceSums(ctx context.Context, q Querier, slices []prSlice) error {
	if len(slices) == 0 {
		return nil
	}
	var b strings.Builder
	b.WriteByte('[')
	for i, s := range slices {
		if i > 0 {
			b.WriteByte(',')
		}
		js, _ := json.Marshal(s.session)
		fmt.Fprintf(&b, "[%s,%d,%d]", js, s.lo, s.hi)
	}
	b.WriteByte(']')
	rows, err := q.QueryContext(ctx, `
		WITH a(i, sid, lo, hi) AS MATERIALIZED (
		  SELECT CAST(key AS INTEGER), (SELECT s.sid FROM sessions s WHERE s.session_id = json_extract(value, '$[0]')),
		         json_extract(value, '$[1]'), json_extract(value, '$[2]')
		  FROM json_each(?))
		SELECT a.i,
		  (SELECT COALESCE(SUM(e.cost_usd),0) FROM events e INDEXED BY idx_events_attr_work
		   WHERE e.sid = a.sid AND e.ts > a.lo AND e.ts <= a.hi AND e.internal = 0),
		  (SELECT json_array(COALESCE(SUM(e.tokens_in),0), COALESCE(SUM(e.tokens_out),0), COALESCE(SUM(e.cache_read),0), COALESCE(SUM(e.cache_write),0))
		   FROM events e INDEXED BY idx_events_attr_work
		   WHERE e.sid = a.sid AND e.ts > a.lo AND e.ts <= a.hi AND e.internal = 0)
		FROM a`, b.String())
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var i int
		var x prSum
		var tok string
		if err := rows.Scan(&i, &x.cost, &tok); err != nil {
			return err
		}
		var t [4]int64
		if err := json.Unmarshal([]byte(tok), &t); err != nil {
			return err
		}
		x.tok = prTokens{in: t[0], out: t[1], read: t[2], write: t[3]}
		if i >= 0 && i < len(slices) {
			*slices[i].sum = x
		}
	}
	return rows.Err()
}
