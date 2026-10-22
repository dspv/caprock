package store

import (
	"context"
	"errors"
)

// Second Brain's re-tag: the memories made before migration 0069, or by
// hand, have no keywords, so a search in English misses one titled in
// another language. The extraction gives them keywords in batches, in id
// order, when it has no session to read (internal/brain, retag.go). No
// migration of its own: a batch is a brain_runs row with session_id
// BrainRetagSession, from_event_id and through_event_id the first and last
// memory id it covered, nodes the memories it gave keywords, and its
// tokens counted like a read's.

// BrainRetagSession is the brain_runs.session_id of a re-tag batch. No
// session has it: a session id is a UUID or an agent's own id, never this.
const BrainRetagSession = "caprock:retag"

// brainNotRetag leaves the re-tag's rows out of what lists sessions' reads.
const brainNotRetag = `r.session_id != '` + BrainRetagSession + `'`

// brainUntaggedWhere is a memory the re-tag still has to give keywords: a
// memory (not an entity, not an imported note) with none.
const brainUntaggedWhere = `kind IN ('idea','decision','finding','question') AND keywords = ''`

// BrainRetagCursor is the highest memory id a re-tag batch went through
// without failing (answered, or given up): the re-tag goes on above it.
func BrainRetagCursor(ctx context.Context, q Querier) (int64, error) {
	var n int64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(MAX(through_event_id), 0) FROM brain_runs
		WHERE session_id = ? AND status != 'failed'`, BrainRetagSession).Scan(&n)
	return n, err
}

// BrainUntagged returns the memories without keywords above a memory id,
// lowest id first, at most limit.
func BrainUntagged(ctx context.Context, q Querier, after int64, limit int) ([]BrainNode, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+brainCols+` FROM brain_nodes n
		WHERE n.id > ? AND n.`+brainUntaggedWhere+` ORDER BY n.id LIMIT ?`, after, limit)
	if err != nil {
		return nil, err
	}
	return scanBrainRows(rows)
}

// CountBrainUntagged counts the memories without keywords above a memory id.
func CountBrainUntagged(ctx context.Context, q Querier, after int64) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM brain_nodes WHERE id > ? AND `+brainUntaggedWhere, after).Scan(&n)
	return n, err
}

// BrainRetagDone is how many memories the re-tag has given keywords.
func BrainRetagDone(ctx context.Context, q Querier) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(nodes), 0) FROM brain_runs
		WHERE session_id = ? AND status = 'ok'`, BrainRetagSession).Scan(&n)
	return n, err
}

// SetBrainKeywords gives a memory that has none its keywords, cleaned as an
// extraction's are, and writes them into its search document. It reports
// whether it did: a memory that has keywords by now (a read or another
// batch got there first), that is not a memory, or that is gone, is left as
// it is. updated_at does not move: keywords are a search aid, not an edit.
func SetBrainKeywords(ctx context.Context, q Querier, id int64, keywords []string) (bool, error) {
	kw := CleanBrainKeywords(keywords)
	if len(kw) == 0 {
		return false, nil
	}
	n, err := GetBrainNode(ctx, q, id)
	if errors.Is(err, ErrBrainNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if len(n.Keywords) > 0 || !IsBrainKind(n.Kind) || IsBrainEntity(n.Kind) || n.Kind == BrainNote {
		return false, nil
	}
	extra, err := brainSearchExtra(ctx, q, n)
	if err != nil {
		return false, err
	}
	summaryDoc := n.Summary
	if extra != "" {
		summaryDoc += "\n" + extra
	}
	res, err := q.ExecContext(ctx, `UPDATE brain_nodes SET keywords = ?, search = ? WHERE id = ? AND keywords = ''`,
		kw.String(), BrainSearchDoc(n.Title, summaryDoc, n.Source.Project, kw...), id)
	if err != nil {
		return false, err
	}
	c, err := res.RowsAffected()
	return c > 0, err
}
