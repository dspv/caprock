package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"unicode/utf8"
)

// Compaction stats (migration 0077; ADR-085 as amended 2026-10-30; contract
// in 03-contracts.md § Compaction stats DDL): what each main-thread
// compaction cost and what it has saved since, as an estimate from the
// pricing table. This file reads and writes the rows; the pricing is
// rollup.RefreshCompactionStats', which has the table.

// MetaCompactionStatsBackfilled is "1" once compaction_stats holds a row for
// every boundary stored before migration 0077, with the summary lengths read
// back from the transcripts (daemon.backfillCompactionStats).
const MetaCompactionStatsBackfilled = "compaction_stats_backfilled"

// SummaryCharsPerToken is how many characters of a compaction's summary are
// taken as one output token: the usual rule of thumb for English prose, an
// estimate (rule 6), since the transcript carries no usage for the call.
const SummaryCharsPerToken = 4

// CompactionStat is one compaction_stats row.
type CompactionStat struct {
	EventID          int64
	Sid              int64
	At               int64
	Trigger          string
	Model            string
	PreTokens        int64
	PostTokens       int64
	SummaryChars     sql.NullInt64
	SummaryTokensEst sql.NullInt64
	Warm             bool
	EstCostUSD       sql.NullFloat64
	TurnsAfter       int64
	EstSavedUSD      float64
	CountedTs        int64
	CountedID        int64
	NextAt           sql.NullInt64
	CostStale        bool
	PricingVersion   string
	UpdatedAt        int64
}

const compactionStatCols = `event_id, sid, at, trigger, model, pre_tokens, post_tokens, summary_chars,
	summary_tokens_est, warm, est_cost_usd, turns_after, est_saved_usd, counted_ts, counted_id, next_at,
	cost_stale, pricing_version, updated_at`

func scanCompactionStat(sc interface{ Scan(...any) error }) (CompactionStat, error) {
	var c CompactionStat
	err := sc.Scan(&c.EventID, &c.Sid, &c.At, &c.Trigger, &c.Model, &c.PreTokens, &c.PostTokens, &c.SummaryChars,
		&c.SummaryTokensEst, &c.Warm, &c.EstCostUSD, &c.TurnsAfter, &c.EstSavedUSD, &c.CountedTs, &c.CountedID,
		&c.NextAt, &c.CostStale, &c.PricingVersion, &c.UpdatedAt)
	return c, err
}

// notCopyWhere leaves out a boundary another session stored first under
// the same key: a fork (--fork-session) copies its parent's lines, the
// boundary among them, and the compaction was made — and paid for — once.
const notCopyWhere = ` AND NOT EXISTS (SELECT 1 FROM events o INDEXED BY idx_events_kind_id
	WHERE o.kind = 'context.compacted' AND o.key = e.key AND o.id < e.id)`

// AddCompactionBoundaries gives every main-thread context.compacted event
// newer than the newest row a bare row, to be filled by
// ReinitCompactionStat (pricing_version ”). A boundary is always stored
// after the ones before it in the table, the transcript backfill too, so
// the newest row's event id is a cursor.
func AddCompactionBoundaries(ctx context.Context, q Querier) (int64, error) {
	res, err := q.ExecContext(ctx, `
		INSERT INTO compaction_stats(event_id, sid, at, pricing_version)
		SELECT e.id, e.sid, e.ts, '' FROM events e INDEXED BY idx_events_kind_id
		WHERE e.kind = 'context.compacted'
		  AND e.id > COALESCE((SELECT MAX(event_id) FROM compaction_stats), 0)
		  AND `+MainThreadWhere+notCopyWhere+`
		ON CONFLICT(event_id) DO NOTHING`)
	if err != nil {
		return 0, fmt.Errorf("add compaction boundaries: %w", err)
	}
	return res.RowsAffected()
}

// CompactionStatsToInit is the rows whose figures were made under another
// pricing table version, or never made (”).
func CompactionStatsToInit(ctx context.Context, q Querier, pricingVersion string) ([]int64, error) {
	rows, err := q.QueryContext(ctx, `SELECT event_id FROM compaction_stats WHERE pricing_version != ? ORDER BY at, event_id`, pricingVersion)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ReinitCompactionStat reads a row's boundary again — trigger, sizes, the
// session's next main-thread boundary — and starts its count over: the
// saving is counted again from the boundary, the cost made again. It also
// closes the session's previous compaction at this one, starting that one's
// count over when it had counted past it. A row whose event is gone is
// deleted; ok is false then.
func ReinitCompactionStat(ctx context.Context, q Querier, eventID int64) (ok bool, err error) {
	var (
		sid, ts, pre, post int64
		trigger            string
		next               sql.NullInt64
	)
	err = q.QueryRowContext(ctx, `
		SELECT e.sid, e.ts, COALESCE(json_extract(e.payload, '$.trigger'), ''),
			COALESCE(json_extract(e.payload, '$.pre_tokens'), 0), COALESCE(json_extract(e.payload, '$.post_tokens'), 0),
			(SELECT MIN(n.ts) FROM events n INDEXED BY idx_events_kind_ts
			  WHERE n.kind = 'context.compacted' AND n.ts > e.ts AND n.sid = e.sid
			    AND COALESCE(n.agent_id, '') = '' AND json_extract(n.payload, '$.sidechain') IS NOT 1)
		FROM events e WHERE e.id = ? AND e.kind = 'context.compacted'`, eventID).
		Scan(&sid, &ts, &trigger, &pre, &post, &next)
	if errors.Is(err, sql.ErrNoRows) {
		_, err = q.ExecContext(ctx, `DELETE FROM compaction_stats WHERE event_id = ?`, eventID)
		return false, err
	}
	if err != nil {
		return false, err
	}
	if _, err := q.ExecContext(ctx, `
		UPDATE compaction_stats SET sid = ?, at = ?, trigger = ?, pre_tokens = ?, post_tokens = ?, next_at = ?,
			turns_after = 0, est_saved_usd = 0, counted_ts = ?, counted_id = 0, cost_stale = 1
		WHERE event_id = ?`, sid, ts, trigger, max(pre, 0), max(post, 0), next, ts, eventID); err != nil {
		return false, err
	}
	// The one before closes here; it counted calls up to its old end (or
	// none), so a count that ran past this boundary is started over.
	_, err = q.ExecContext(ctx, `
		UPDATE compaction_stats SET
			turns_after = CASE WHEN counted_ts >= ? THEN 0 ELSE turns_after END,
			est_saved_usd = CASE WHEN counted_ts >= ? THEN 0 ELSE est_saved_usd END,
			counted_id = CASE WHEN counted_ts >= ? THEN 0 ELSE counted_id END,
			counted_ts = CASE WHEN counted_ts >= ? THEN at ELSE counted_ts END,
			next_at = ?
		WHERE event_id = (SELECT event_id FROM compaction_stats WHERE sid = ? AND at < ? ORDER BY at DESC, event_id DESC LIMIT 1)
		  AND (next_at IS NULL OR next_at > ?)`, ts, ts, ts, ts, ts, sid, ts, ts)
	return err == nil, err
}

// OpenCompactionStats is the rows with something left to do: a cost to make
// again, or calls that may still land before the session's next boundary
// (or at all, for its newest). A closed row whose count reached its next
// boundary is settled (counted_ts = next_at).
func OpenCompactionStats(ctx context.Context, q Querier) ([]CompactionStat, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+compactionStatCols+` FROM compaction_stats
		WHERE cost_stale = 1 OR next_at IS NULL OR counted_ts < next_at ORDER BY at, event_id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []CompactionStat
	for rows.Next() {
		c, err := scanCompactionStat(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SaveCompactionStat writes a row's figures back.
func SaveCompactionStat(ctx context.Context, q Querier, c CompactionStat) error {
	_, err := q.ExecContext(ctx, `
		UPDATE compaction_stats SET model = ?, post_tokens = ?, warm = ?, est_cost_usd = ?, turns_after = ?,
			est_saved_usd = ?, counted_ts = ?, counted_id = ?, cost_stale = ?, pricing_version = ?, updated_at = ?
		WHERE event_id = ?`, c.Model, c.PostTokens, c.Warm, c.EstCostUSD, c.TurnsAfter,
		c.EstSavedUSD, c.CountedTs, c.CountedID, c.CostStale, c.PricingVersion, c.UpdatedAt, c.EventID)
	return err
}

// LatestCompactionStat is a session's newest compaction row.
func LatestCompactionStat(ctx context.Context, q Querier, sessionID string) (CompactionStat, bool, error) {
	c, err := scanCompactionStat(q.QueryRowContext(ctx, `SELECT `+compactionStatCols+` FROM compaction_stats
		WHERE sid = (SELECT sid FROM sessions WHERE session_id = ?) ORDER BY at DESC, event_id DESC LIMIT 1`, sessionID))
	if errors.Is(err, sql.ErrNoRows) {
		return CompactionStat{}, false, nil
	}
	return c, err == nil, err
}

// CompactionCall is one main-thread assistant call as the compaction
// estimate reads it.
type CompactionCall struct {
	ID, Ts                                        int64
	Model                                         string
	TokensIn, CacheRead, CacheWrite, CacheWrite1h int64
}

// Prompt is the context the call sent: input, cache read and cache write.
func (c CompactionCall) Prompt() int64 { return c.TokensIn + c.CacheRead + c.CacheWrite }

// mainCallWhere is a main-thread assistant call that was really made: usage
// above zero (a message Claude Code copies past a compaction keeps its id and
// is not stored twice, and one whose usage reads zero is not a call).
const mainCallWhere = `t.kind = 'turn.assistant' AND t.internal = 0 AND t.tokens_in IS NOT NULL
	AND COALESCE(t.tokens_in, 0) + COALESCE(t.cache_read, 0) + COALESCE(t.cache_write, 0) > 0
	AND COALESCE(t.agent_id, '') = '' AND json_extract(t.payload, '$.sidechain') IS NOT 1`

func scanCalls(rows *sql.Rows) ([]CompactionCall, error) {
	defer func() { _ = rows.Close() }()
	var out []CompactionCall
	for rows.Next() {
		var c CompactionCall
		if err := rows.Scan(&c.ID, &c.Ts, &c.Model, &c.TokensIn, &c.CacheRead, &c.CacheWrite, &c.CacheWrite1h); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

const callCols = `t.id, t.ts, COALESCE(t.model, ''), COALESCE(t.tokens_in, 0), COALESCE(t.cache_read, 0),
	COALESCE(t.cache_write, 0), COALESCE(t.cache_write_1h, 0)`

// MainCallsBefore is up to limit of a session's main-thread calls before ts,
// newest first: what the compaction's model and cache state are read from.
func MainCallsBefore(ctx context.Context, q Querier, sid, ts int64, limit int) ([]CompactionCall, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+callCols+` FROM events t INDEXED BY idx_events_session_ts
		WHERE t.sid = ? AND t.ts < ? AND `+mainCallWhere+` ORDER BY t.ts DESC, t.id DESC LIMIT ?`, sid, ts, limit)
	if err != nil {
		return nil, err
	}
	return scanCalls(rows)
}

// MainCallsAfter is a session's main-thread calls after the cursor (ts, id)
// and before `before` (unix ms), oldest first, at most limit.
func MainCallsAfter(ctx context.Context, q Querier, sid, fromTs, fromID, before int64, limit int) ([]CompactionCall, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+callCols+` FROM events t INDEXED BY idx_events_session_ts
		WHERE t.sid = ? AND t.ts >= ? AND t.ts < ? AND (t.ts > ? OR t.id > ?) AND `+mainCallWhere+`
		ORDER BY t.ts, t.id LIMIT ?`, sid, fromTs, before, fromTs, fromID, limit)
	if err != nil {
		return nil, err
	}
	return scanCalls(rows)
}

// SetCompactionSummary records the length of a compaction's summary — the
// isCompactSummary user message Claude Code puts in the context after the
// boundary — and marks the row's cost to be made again. boundaryUUID is the
// boundary the message follows: the last compact_boundary line before it in
// the file. The message's own parentUuid is that boundary's uuid on newer
// Claude Code versions and a line between the two on older ones (2.1.285,
// 2026-10-04), and its timestamp can be a moment before the boundary's, so
// neither is relied on alone: a uuid with no stored boundary falls back to
// the session's newest main-thread boundary, which the line follows. A row
// the refresh has not made yet is started here; nothing is written when the
// session has no main-thread boundary.
func SetCompactionSummary(ctx context.Context, q Querier, sessionID, boundaryUUID, text string) error {
	n := int64(utf8.RuneCountInString(text))
	_, err := q.ExecContext(ctx, `
		WITH s AS (SELECT sid FROM sessions WHERE session_id = ?)
		INSERT INTO compaction_stats(event_id, sid, at, summary_chars, summary_tokens_est, cost_stale, pricing_version)
		SELECT e.id, e.sid, e.ts, ?, ?, 1, '' FROM events e
		WHERE e.id = COALESCE(
			(SELECT k.id FROM events k WHERE k.sid = (SELECT sid FROM s) AND k.key = ? AND k.kind = 'context.compacted'),
			(SELECT b.id FROM events b INDEXED BY idx_events_session_id
			  WHERE b.sid = (SELECT sid FROM s) AND b.kind = 'context.compacted'
			    AND COALESCE(b.agent_id, '') = '' AND json_extract(b.payload, '$.sidechain') IS NOT 1
			  ORDER BY b.id DESC LIMIT 1))
		  AND `+MainThreadWhere+notCopyWhere+`
		ON CONFLICT(event_id) DO UPDATE SET summary_chars = excluded.summary_chars,
			summary_tokens_est = excluded.summary_tokens_est, cost_stale = 1
		WHERE compaction_stats.summary_chars IS NOT excluded.summary_chars`,
		sessionID, n, n/SummaryCharsPerToken, "compact:"+boundaryUUID)
	return err
}

// CompactionsMissingSummary is the sessions (id, transcript path) with a
// compaction whose summary length is not known: what the backfill reads.
func CompactionsMissingSummary(ctx context.Context, q Querier) ([][2]string, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT s.session_id, COALESCE(s.transcript_path, '') FROM sessions s
		WHERE s.sid IN (SELECT sid FROM compaction_stats WHERE summary_chars IS NULL)
		  AND COALESCE(s.transcript_path, '') != ''`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out [][2]string
	for rows.Next() {
		var id, path string
		if err := rows.Scan(&id, &path); err != nil {
			return nil, err
		}
		out = append(out, [2]string{id, path})
	}
	return out, rows.Err()
}

// CompactionTotals is the compactions of a window, by the boundary's time:
// how many, their estimated cost and what each has saved to date.
type CompactionTotals struct {
	From  int64 `json:"from"`
	To    int64 `json:"to"`
	Count int   `json:"count"`
	// Priced is how many of Count have a cost (their model is in the
	// pricing table); the sums are over those.
	Priced      int     `json:"priced"`
	EstCostUSD  float64 `json:"est_cost_usd"`
	EstSavedUSD float64 `json:"est_saved_usd"`
	NetUSD      float64 `json:"net_usd"`
	TurnsAfter  int64   `json:"turns_after"`
	// MedianCostUSD and MedianSavedUSD are over the priced ones.
	MedianCostUSD  float64 `json:"median_cost_usd"`
	MedianSavedUSD float64 `json:"median_saved_usd"`
}

// CompactionTotalsBetween sums the rows with from <= at < to (unix ms).
func CompactionTotalsBetween(ctx context.Context, q Querier, from, to int64) (CompactionTotals, error) {
	t := CompactionTotals{From: from, To: to}
	rows, err := q.QueryContext(ctx, `SELECT est_cost_usd, est_saved_usd, turns_after FROM compaction_stats
		WHERE at >= ? AND at < ? ORDER BY at`, from, to)
	if err != nil {
		return t, err
	}
	defer func() { _ = rows.Close() }()
	var costs, saved []float64
	for rows.Next() {
		var c sql.NullFloat64
		var s float64
		var n int64
		if err := rows.Scan(&c, &s, &n); err != nil {
			return t, err
		}
		t.Count++
		t.TurnsAfter += n
		if !c.Valid {
			continue
		}
		t.Priced++
		t.EstCostUSD += c.Float64
		t.EstSavedUSD += s
		costs, saved = append(costs, c.Float64), append(saved, s)
	}
	if err := rows.Err(); err != nil {
		return t, err
	}
	t.NetUSD = t.EstSavedUSD - t.EstCostUSD
	if len(costs) > 0 {
		sort.Float64s(costs)
		sort.Float64s(saved)
		t.MedianCostUSD, t.MedianSavedUSD = medianF(costs), medianF(saved)
	}
	return t, nil
}
