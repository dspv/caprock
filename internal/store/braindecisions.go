package store

import (
	"context"
	"strconv"
	"strings"
)

// Second Brain's current decisions (migration 0069; 03-contracts.md § Second
// Brain, *Current decisions*). A decision is current until a newer memory
// has a supersedes edge to it. The extraction is shown a project's newest
// current decisions with their ids and may answer that a new decision
// supersedes one of them; a new session's handoff and the MCP tool
// current_decisions read the same registry.

// brainNotSuperseded is the condition, over brain_nodes n, that no
// supersedes edge points at the node.
const brainNotSuperseded = `NOT EXISTS (SELECT 1 FROM brain_edges s WHERE s.dst = n.id AND s.kind = 'supersedes')`

// brainSupersededBy maps each of ids that is superseded to the newest
// memory superseding it.
func brainSupersededBy(ctx context.Context, q Querier, ids []int64) (map[int64]int64, error) {
	out := map[int64]int64{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.QueryContext(ctx, `SELECT dst, MAX(src) FROM brain_edges
		WHERE kind = 'supersedes' AND dst IN (SELECT value FROM json_each(?)) GROUP BY dst`, idList(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var dst, src int64
		if err := rows.Scan(&dst, &src); err != nil {
			return nil, err
		}
		out[dst] = src
	}
	return out, rows.Err()
}

// markBrainSuperseded fills SupersededBy on nodes, with one read.
func markBrainSuperseded(ctx context.Context, q Querier, nodes []BrainNode) error {
	if len(nodes) == 0 {
		return nil
	}
	by, err := brainSupersededBy(ctx, q, nodeIDs(nodes))
	if err != nil {
		return err
	}
	for i := range nodes {
		nodes[i].SupersededBy = by[nodes[i].ID]
	}
	return nil
}

// BrainCurrentDecisions returns a project's decisions that nothing
// supersedes, newest first, at most limit. agents keeps out what may not
// reach an MCP client (brainMCPMayRead).
func BrainCurrentDecisions(ctx context.Context, q Querier, project string, limit int, agents bool) ([]BrainNode, error) {
	cond := ""
	if agents {
		cond = " AND " + brainMCPMayRead
	}
	rows, err := q.QueryContext(ctx, `SELECT `+brainCols+` FROM brain_nodes n
		WHERE n.project = ? AND n.kind = 'decision' AND `+brainNotSuperseded+cond+`
		ORDER BY n.created_at DESC, n.id DESC LIMIT ?`, project, limit)
	if err != nil {
		return nil, err
	}
	return scanBrainRows(rows)
}

// BrainRecentMemories returns a project's newest memories of any kind but
// imported notes, newest first, for a read to be shown what is already kept.
func BrainRecentMemories(ctx context.Context, q Querier, project string, limit int) ([]BrainNode, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+brainCols+` FROM brain_nodes n
		WHERE n.project = ? AND n.kind IN ('idea','decision','finding','question')
		ORDER BY n.created_at DESC, n.id DESC LIMIT ?`, project, limit)
	if err != nil {
		return nil, err
	}
	return scanBrainRows(rows)
}

// BrainNearDuplicate is how alike two titles' words must be — shared words
// over all their words (Jaccard), folded — for a new memory to be the same
// as one already kept: "Scout stays read-only" and "The scout stays
// read-only" are 0.8.
const BrainNearDuplicate = 0.75

// brainTitleWords folds a title and returns its distinct words.
func brainTitleWords(title string) map[string]bool {
	out := map[string]bool{}
	eachToken(FoldSearch(title), func(t string) bool {
		out[t] = true
		return true
	})
	return out
}

// BrainTitlesNear reports whether two titles say the same thing by their
// words: at least two words each, and a Jaccard overlap of
// BrainNearDuplicate or more. A title in a script written without spaces is
// one word, so only the same title is near it.
func BrainTitlesNear(a, b string) bool {
	wa, wb := brainTitleWords(a), brainTitleWords(b)
	if len(wa) == 0 || len(wb) == 0 {
		return false
	}
	if len(wa) < 2 || len(wb) < 2 {
		return NormTitle(a) == NormTitle(b)
	}
	shared := 0
	for w := range wa {
		if wb[w] {
			shared++
		}
	}
	union := len(wa) + len(wb) - shared
	return float64(shared)/float64(union) >= BrainNearDuplicate
}

// BrainSupersede records that memory newer replaces older. Both must exist,
// be in the same project and be memories; older must be a decision. Anything
// else is ErrBrainInvalid, so a model's stray id cannot retire a memory
// elsewhere.
func BrainSupersede(ctx context.Context, q Querier, newer, older int64, now int64) error {
	if newer == older {
		return brainInvalid("a memory cannot supersede itself")
	}
	n, err := GetBrainNode(ctx, q, newer)
	if err != nil {
		return err
	}
	o, err := GetBrainNode(ctx, q, older)
	if err != nil {
		return err
	}
	if o.Kind != BrainDecision || IsBrainEntity(n.Kind) || n.Kind == BrainNote || n.Source.Project != o.Source.Project {
		return brainInvalid("only a decision of the same project can be superseded")
	}
	return LinkBrain(ctx, q, newer, older, EdgeSupersedes, 1, now)
}

// BrainDecisionLine is how a decision is shown to a read or handed to a
// session: its id and title, one line.
func BrainDecisionLine(n BrainNode) string {
	return "#" + strconv.FormatInt(n.ID, 10) + " " + strings.Join(strings.Fields(n.Title), " ")
}
