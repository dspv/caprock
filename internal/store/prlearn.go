package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Pull requests no session recorded, matched by GitHub's own stamps
// (2026-10-25). session_prs is filled from the `gh pr` commands agents ran
// (gitremote.FromToolPost), so a pull request a script made — `bash
// relgen.sh` running `gh pr create` and `gh pr merge` inside, or `PR=$(gh pr
// create …)`, which neither Claude Code nor the parser reads as one — had no
// row, and the work of the session that drove it was never cut to it: on the
// owner's board v0.155.0, v0.157.0 and v0.158.0 read "–" while v0.156.0,
// whose feature pull request was opened plainly, read $9.23.
//
// github_prs (migration 0071) holds the moment GitHub says each pull request
// was opened and merged. A moment no session recorded for that pull request
// is given to the session of the repository that was demonstrably acting
// then: one with a Bash call started before it and finished after it. Only
// when exactly one session had one; none or several, and it stays
// unattributed. The match is derived at read time and never stored, so it
// is never mistaken for a command a session ran, and a session's cut is the
// same whichever pull requests are asked for: every stamp of the
// repository's is matched, not only the ones asked for.

// learnLookback is how long before a stamp a Bash call may have started and
// still be the one running over it: past Claude Code's longest foreground
// call (10 minutes), with room. A stamp older than this is settled — every
// call that could match it has ended — and its match is kept (learnMemo).
const learnLookback = 15 * 60 * 1000

// learnNow is the clock that says which stamps are settled (tests).
var learnNow = func() int64 { return time.Now().UnixMilli() }

// learnedPR is a pull request a session is taken to have opened or merged:
// the moment its Bash call over GitHub's stamp finished, as if the `gh pr`
// command had been recorded (store.RecordPR stamps the PostToolUse).
type learnedPR struct {
	session, url   string
	opened, merged int64
}

type prStamp struct {
	url    string
	merge  bool
	at     int64
	key    string
	result learnHit
}

// learnHit is a stamp's match: the session and its call's end, or none.
type learnHit struct {
	session string
	end     int64
}

// learnPRs matches the stamps in github_prs no session recorded, for every
// repository the pull requests prs belong to, to the sessions of repoRoot.
func learnPRs(ctx context.Context, q Querier, repoRoot string, prs []PRRef) ([]learnedPR, error) {
	if repoRoot == "" {
		return nil, nil
	}
	repos := map[string]bool{}
	for _, p := range prs {
		if r := prRepo(p.URL); r != "" {
			repos[strings.ToLower(r)] = true
		}
	}
	var out []learnedPR
	for repo := range repos {
		got, err := learnRepo(ctx, q, repoRoot, repo)
		if err != nil {
			return nil, err
		}
		out = append(out, got...)
	}
	return out, nil
}

func learnRepo(ctx context.Context, q Querier, repoRoot, repo string) ([]learnedPR, error) {
	// What the sessions recorded, per pull request: a recorded opening or
	// merge is never second-guessed.
	prefix := PRURLPrefix(repo)
	type rec struct{ opened, merged bool }
	recorded := map[string]rec{}
	rows, err := q.QueryContext(ctx, `
		SELECT url, MAX(opened_at > 0), MAX(merged_at > 0)
		FROM session_prs WHERE lower(substr(url, 1, ?)) = lower(?)
		GROUP BY url`, len(prefix), prefix)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var url string
		var r rec
		if err := rows.Scan(&url, &r.opened, &r.merged); err != nil {
			rows.Close()
			return nil, err
		}
		recorded[url] = r
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	var stamps []*prStamp
	rows, err = q.QueryContext(ctx, `SELECT url, created_at, merged_at FROM github_prs WHERE repo = ?`, repo)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var url string
		var created, merged int64
		if err := rows.Scan(&url, &created, &merged); err != nil {
			rows.Close()
			return nil, err
		}
		r := recorded[url]
		if created > 0 && !r.opened {
			stamps = append(stamps, &prStamp{url: url, at: created})
		}
		if merged > 0 && !r.merged {
			stamps = append(stamps, &prStamp{url: url, merge: true, at: merged})
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	now := learnNow()
	var ask []*prStamp
	for _, s := range stamps {
		s.key = fmt.Sprintf("%p|%s|%s|%v|%d", q, repoRoot, s.url, s.merge, s.at)
		if h, ok := learnMemo.get(s.key); ok {
			s.result = h
			continue
		}
		ask = append(ask, s)
	}
	if err := learnMatch(ctx, q, repoRoot, ask); err != nil {
		return nil, err
	}
	for _, s := range ask {
		if now-s.at > learnLookback {
			learnMemo.put(s.key, s.result)
		}
	}

	byKey := map[[2]string]*learnedPR{}
	var out []learnedPR
	var order [][2]string
	for _, s := range stamps {
		if s.result.session == "" {
			continue
		}
		k := [2]string{s.result.session, s.url}
		l := byKey[k]
		if l == nil {
			l = &learnedPR{session: s.result.session, url: s.url}
			byKey[k] = l
			order = append(order, k)
		}
		if s.merge {
			l.merged = s.result.end
		} else {
			l.opened = s.result.end
		}
	}
	for _, k := range order {
		out = append(out, *byKey[k])
	}
	return out, nil
}

// learnMatch finds, for each stamp, the sessions of repoRoot with a Bash
// call over it, in one statement: a call whose PreToolUse came before the
// stamp's second ended (GitHub stamps whole seconds) and whose PostToolUse
// came at or after it, paired by tool-use id. A stamp with exactly one such
// session is that session's, at its earliest call's end. The stamps lead
// (CROSS JOIN): each is one range of idx_events_tool_dist, where the planner
// left to itself walked every tool.pre row once per stamp (6.9 s for three
// stamps on a copy of the owner's database, 6 ms in this order; 2026-10-25).
func learnMatch(ctx context.Context, q Querier, repoRoot string, stamps []*prStamp) error {
	if len(stamps) == 0 {
		return nil
	}
	ats := make([]int64, len(stamps))
	for i, s := range stamps {
		ats[i] = s.at
	}
	js, _ := json.Marshal(ats)
	rows, err := q.QueryContext(ctx, `
		WITH a(i, at) AS MATERIALIZED (
		  SELECT CAST(key AS INTEGER), CAST(value AS INTEGER) FROM json_each(?))
		SELECT a.i, s.session_id, MIN(e.ts)
		FROM a CROSS JOIN events p INDEXED BY idx_events_tool_dist
		JOIN sessions s ON s.sid = p.sid AND s.repo_root = ?
		JOIN events e ON e.sid = p.sid AND e.key = 'post:' || substr(p.key, 5)
		WHERE p.kind = 'tool.pre' AND p.ts >= a.at - ? AND p.ts < a.at + 1000 AND p.tool = 'Bash' AND p.internal = 0
		  AND p.key LIKE 'pre:%' AND e.ts >= a.at
		GROUP BY a.i, p.sid`, string(js), repoRoot, learnLookback)
	if err != nil {
		return err
	}
	defer rows.Close()
	seen := make([]int, len(stamps))
	for rows.Next() {
		var i int
		var h learnHit
		if err := rows.Scan(&i, &h.session, &h.end); err != nil {
			return err
		}
		if i < 0 || i >= len(stamps) {
			continue
		}
		seen[i]++
		stamps[i].result = h
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i, n := range seen {
		if n != 1 {
			stamps[i].result = learnHit{} // none, or several: not attributed
		}
	}
	return nil
}

// recordedDrives is, for each session in lrn, the pull requests it recorded
// opening or merging (session_prs), so a learned one is counted once.
func recordedDrives(ctx context.Context, q Querier, lrn map[string][]learnedPR) (map[string]map[string]bool, error) {
	out := map[string]map[string]bool{}
	if len(lrn) == 0 {
		return out, nil
	}
	args := make([]any, 0, len(lrn))
	for id := range lrn {
		args = append(args, id)
	}
	rows, err := q.QueryContext(ctx, `
		SELECT session_id, url FROM session_prs
		WHERE (opened_at > 0 OR merged_at > 0) AND session_id IN (?`+strings.Repeat(",?", len(args)-1)+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, url string
		if err := rows.Scan(&id, &url); err != nil {
			return nil, err
		}
		if out[id] == nil {
			out[id] = map[string]bool{}
		}
		out[id][url] = true
	}
	return out, rows.Err()
}

// prRepo is the owner/name of a github.com pull request address, else "".
func prRepo(url string) string {
	rest, ok := strings.CutPrefix(url, "https://github.com/")
	if !ok {
		return ""
	}
	parts := strings.SplitN(rest, "/", 4)
	if len(parts) < 4 || parts[0] == "" || parts[1] == "" || parts[2] != "pull" {
		return ""
	}
	return parts[0] + "/" + parts[1]
}

// learnMemo keeps settled stamps' matches, per database, repository root and
// stamp: matching every stamp of the owner's repository again on each read
// would read the Bash calls around each one.
var learnMemo = &hitMemo{m: map[string]learnHit{}}

// learnMemoMax bounds the stamps kept; past it the memo starts over.
const learnMemoMax = 8192

type hitMemo struct {
	mu sync.Mutex
	m  map[string]learnHit
}

func (c *hitMemo) get(key string) (learnHit, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	h, ok := c.m[key]
	return h, ok
}

func (c *hitMemo) put(key string, h learnHit) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.m[key]; !ok && len(c.m) >= learnMemoMax {
		c.m = map[string]learnHit{}
	}
	c.m[key] = h
}

func (c *hitMemo) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m = map[string]learnHit{}
}
