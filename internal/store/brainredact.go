package store

import (
	"context"
	"errors"

	"github.com/dspv/caprock/internal/redact"
)

// Second Brain's privacy filter: what a memory says is handed on — to later
// sessions (the handoff), to other projects' screens, to agents through
// `caprock mcp` — so a credential or a card number that lands in one would
// spread. Every write of a memory's title, summary and keywords goes through
// redactBrain first (InsertBrainNode, UpdateBrainNode, SetBrainKeywords), and
// an imported note's excerpt is redacted when it is parsed (obsidian). The
// memories kept before the filter are scrubbed once (ScrubBrainSecrets).

// MetaBrainScrubbed marks that the memories and note excerpts stored before
// the privacy filter have been scrubbed once (ScrubBrainSecrets).
const MetaBrainScrubbed = "brain_secrets_scrubbed"

// redactBrain redacts a memory's title, summary and keywords. A keyword that
// held a secret is dropped: a keyword is a search aid, and a placeholder
// finds nothing.
func redactBrain(title, summary string, keywords []string) (string, string, BrainKeywords, redact.Counts) {
	counts := redact.Counts{}
	title, c := redact.Text(title)
	counts.Add(c)
	summary, c = redact.Text(summary)
	counts.Add(c)
	kw := BrainKeywords{}
	for _, k := range keywords {
		if _, c := redact.Text(k); c.Total() > 0 {
			counts.Add(c)
			continue
		}
		kw = append(kw, k)
	}
	return title, summary, kw, counts
}

// ScrubBrainSecrets redacts, in place, every node's title, summary and
// keywords and every imported note's excerpt that holds a value the filter
// finds, rebuilding the search document of each node it changes. It returns
// how many nodes and note rows changed and the values replaced, by kind. It
// is idempotent: a second run finds nothing. An entity whose redacted title
// would collide with another of its kind keeps its title.
func ScrubBrainSecrets(ctx context.Context, q Querier, now int64) (nodes, notes int, counts redact.Counts, err error) {
	counts = redact.Counts{}
	// Note excerpts first: a node's search document is rebuilt from them.
	type excerpt struct {
		id, node int64
		text     string
	}
	var ex []excerpt
	rows, err := q.QueryContext(ctx, `SELECT id, COALESCE(node_id, 0), excerpt FROM brain_vault_notes`)
	if err != nil {
		return 0, 0, nil, err
	}
	for rows.Next() {
		var e excerpt
		if err := rows.Scan(&e.id, &e.node, &e.text); err != nil {
			rows.Close()
			return 0, 0, nil, err
		}
		if r, c := redact.Text(e.text); c.Total() > 0 {
			e.text = r
			counts.Add(c)
			ex = append(ex, e)
		}
	}
	if err := rows.Close(); err != nil {
		return 0, 0, nil, err
	}
	if err := rows.Err(); err != nil {
		return 0, 0, nil, err
	}
	resync := map[int64]bool{}
	for _, e := range ex {
		if _, err := q.ExecContext(ctx, `UPDATE brain_vault_notes SET excerpt = ? WHERE id = ?`, e.text, e.id); err != nil {
			return 0, 0, nil, err
		}
		if e.node > 0 {
			resync[e.node] = true
		}
	}
	notes = len(ex)

	rows, err = q.QueryContext(ctx, `SELECT `+brainCols+` FROM brain_nodes n ORDER BY n.id`)
	if err != nil {
		return 0, 0, nil, err
	}
	all, err := scanBrainRows(rows)
	if err != nil {
		return 0, 0, nil, err
	}
	for _, n := range all {
		title, summary, kw, c := redactBrain(n.Title, n.Summary, n.Keywords)
		if c.Total() == 0 {
			continue
		}
		title = ClipRunes(title, BrainTitleRunes)
		if NormTitle(title) == "" {
			title = n.Title
		}
		if IsBrainEntity(n.Kind) && title != n.Title {
			var other int64
			err := q.QueryRowContext(ctx, `SELECT id FROM brain_nodes WHERE kind = ? AND norm = ? AND id != ?`, n.Kind, NormTitle(title), n.ID).Scan(&other)
			if err == nil {
				title = n.Title
			}
		}
		n.Title, n.Summary, n.Keywords = title, ClipRunes(summary, BrainSummaryRunes), CleanBrainKeywords(kw)
		extra, err := brainSearchExtra(ctx, q, n)
		if err != nil {
			return 0, 0, nil, err
		}
		summaryDoc := n.Summary
		if extra != "" {
			summaryDoc += "\n" + extra
		}
		if _, err := q.ExecContext(ctx, `UPDATE brain_nodes SET title = ?, norm = ?, summary = ?, keywords = ?, search = ? WHERE id = ?`,
			n.Title, NormTitle(n.Title), n.Summary, n.Keywords.String(), BrainSearchDoc(n.Title, summaryDoc, n.Source.Project, n.Keywords...), n.ID); err != nil {
			return 0, 0, nil, err
		}
		if !resync[n.ID] {
			counts.Add(c)
			nodes++
		} else if n.Kind != BrainNote {
			// Its own text, besides the excerpt already counted.
			counts.Add(c)
		}
	}
	// A node whose note excerpt changed takes its summary (a note's) and
	// search from the rows again, as an import does.
	for id := range resync {
		if _, err := SyncBrainNoteNode(ctx, q, id, now); err != nil && !errors.Is(err, ErrBrainNotFound) {
			return 0, 0, nil, err
		}
		nodes++
	}
	return nodes, notes, counts, nil
}
