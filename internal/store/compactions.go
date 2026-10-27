package store

import (
	"context"
	"database/sql"
	"errors"
	"sort"
)

// Compaction is one finished compaction of a session's context, as its
// transcript's compact_boundary line and the turn after it measured it.
type Compaction struct {
	// At is the boundary's time, unix ms.
	At int64 `json:"at"`
	// Trigger is "auto" (Claude Code ran out of room) or "manual" (/compact).
	Trigger string `json:"trigger"`
	// PreTokens is the context before, as Claude Code measured it.
	PreTokens int64 `json:"pre_tokens"`
	// PostTokens is the context after: the boundary's own postTokens when
	// Claude Code wrote one, else the prompt of the first main-thread turn
	// after the boundary (input + cache read + cache write); 0 while neither
	// is known.
	PostTokens int64 `json:"post_tokens,omitempty"`
	// DurationMs is how long the compaction took, when Claude Code said.
	DurationMs int64 `json:"duration_ms,omitempty"`
}

// compactionQuery reads the context.compacted rows `where` picks (newest
// first, at most limit) and the context after each: the boundary's own
// post_tokens when Claude Code wrote one, otherwise the turn after it. The
// turn is the first
// main-thread assistant turn with usage at or after the boundary and before
// the next boundary of the same session: a turn after the next one measures
// that one. A message Claude Code copies past a compaction keeps its id and
// is not stored again (msg:<id>), and one whose usage reads zero is skipped,
// so the turn found is a real call.
//
// The next boundary is found once per boundary, in the inner select, and
// both lookups pin their index: with the bound inside the turn's subquery
// SQLite evaluated it for every candidate turn and walked
// idx_events_attr_work — 1.6 to 2.7 s for 77 boundaries on a copy of the
// owner's 2.3 GB database while the daemon ran, 2 ms this way (2026-10-27).
func compactionQuery(where string) string {
	return `
	SELECT b.ts, b.trigger, b.pre, b.dur,
		COALESCE(b.post, (
			SELECT COALESCE(t.tokens_in, 0) + COALESCE(t.cache_read, 0) + COALESCE(t.cache_write, 0)
			FROM events t INDEXED BY idx_events_session_ts
			WHERE t.sid = b.sid AND t.ts >= b.ts AND t.ts < b.next
			  AND t.kind = 'turn.assistant' AND t.internal = 0 AND t.tokens_in IS NOT NULL
			  AND COALESCE(t.tokens_in, 0) + COALESCE(t.cache_read, 0) + COALESCE(t.cache_write, 0) > 0
			  AND COALESCE(t.agent_id, '') = '' AND json_extract(t.payload, '$.sidechain') IS NOT 1
			ORDER BY t.ts, t.id LIMIT 1
		), 0)
	FROM (
		SELECT e.sid, e.ts,
			COALESCE(json_extract(e.payload, '$.trigger'), '') AS trigger,
			COALESCE(json_extract(e.payload, '$.pre_tokens'), 0) AS pre,
			COALESCE(json_extract(e.payload, '$.duration_ms'), 0) AS dur,
			NULLIF(json_extract(e.payload, '$.post_tokens'), 0) AS post,
			COALESCE((
				SELECT MIN(n.ts) FROM events n INDEXED BY idx_events_kind_ts
				WHERE n.kind = 'context.compacted' AND n.ts > e.ts AND n.sid = e.sid
				  AND COALESCE(n.agent_id, '') = '' AND json_extract(n.payload, '$.sidechain') IS NOT 1
			), 9223372036854775807) AS next
		FROM events e INDEXED BY idx_events_kind_ts
		WHERE e.kind = 'context.compacted' AND ` + MainThreadWhere + where + `
		ORDER BY e.ts DESC, e.id DESC LIMIT ?
	) b
	ORDER BY b.ts DESC`
}

func scanCompaction(sc interface{ Scan(...any) error }) (Compaction, error) {
	var c Compaction
	err := sc.Scan(&c.At, &c.Trigger, &c.PreTokens, &c.DurationMs, &c.PostTokens)
	return c, err
}

// LastCompaction is a session's newest main-thread compaction.
func LastCompaction(ctx context.Context, q Querier, sessionID string) (Compaction, bool, error) {
	row := q.QueryRowContext(ctx, compactionQuery(` AND e.sid = (SELECT sid FROM sessions WHERE session_id = ?)`), sessionID, 1)
	c, err := scanCompaction(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Compaction{}, false, nil
	}
	if err != nil {
		return Compaction{}, false, err
	}
	return c, true, nil
}

// CompactionStatsScan is how many of the newest compactions the typical
// share is measured over.
const CompactionStatsScan = 500

// CompactionStats is what the compactions recorded on this machine kept of
// the context: over the measured ones (a turn followed, the size before is
// known), the median and 90th-percentile share of PreTokens the next turn
// still carried, and the median sizes before and after.
type CompactionStats struct {
	Count      int     `json:"count"`
	MedianKept float64 `json:"median_kept"`
	P90Kept    float64 `json:"p90_kept"`
	MedianPre  int64   `json:"median_pre"`
	MedianPost int64   `json:"median_post"`
	// From and To bound the measured compactions, unix ms.
	From int64 `json:"from"`
	To   int64 `json:"to"`
}

// RecentCompactionStats measures the newest CompactionStatsScan main-thread
// compactions on the machine. Count is 0 when none is measured.
func RecentCompactionStats(ctx context.Context, q Querier) (CompactionStats, error) {
	rows, err := q.QueryContext(ctx, compactionQuery(""), CompactionStatsScan)
	if err != nil {
		return CompactionStats{}, err
	}
	defer func() { _ = rows.Close() }()
	var cs []Compaction
	for rows.Next() {
		c, err := scanCompaction(rows)
		if err != nil {
			return CompactionStats{}, err
		}
		if c.PreTokens > 0 && c.PostTokens > 0 {
			cs = append(cs, c)
		}
	}
	if err := rows.Err(); err != nil {
		return CompactionStats{}, err
	}
	return compactionStats(cs), nil
}

func compactionStats(cs []Compaction) CompactionStats {
	st := CompactionStats{Count: len(cs)}
	if len(cs) == 0 {
		return st
	}
	kept := make([]float64, len(cs))
	pre := make([]int64, len(cs))
	post := make([]int64, len(cs))
	st.From, st.To = cs[0].At, cs[0].At
	for i, c := range cs {
		kept[i] = float64(c.PostTokens) / float64(c.PreTokens)
		pre[i], post[i] = c.PreTokens, c.PostTokens
		st.From, st.To = min(st.From, c.At), max(st.To, c.At)
	}
	sort.Float64s(kept)
	sort.Slice(pre, func(i, j int) bool { return pre[i] < pre[j] })
	sort.Slice(post, func(i, j int) bool { return post[i] < post[j] })
	st.MedianKept = medianF(kept)
	st.P90Kept = kept[min(len(kept)-1, len(kept)*9/10)]
	st.MedianPre, st.MedianPost = medianI(pre), medianI(post)
	return st
}

func medianF(s []float64) float64 {
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

func medianI(s []int64) int64 {
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}
