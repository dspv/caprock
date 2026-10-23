package store

import (
	"context"
	"sort"
	"strconv"
	"strings"
)

// The Pipeline's Most expensive section beyond the board's newest 50 pull
// requests (owner, 2026-10-23): every pull request Caprock knows of in a
// repository, from its own tables only — the ones agents opened, merged or
// closed (session_prs, migration 0035) and the headers of every GitHub list
// the daemon read (github_prs, migration 0072) — each charged by
// SpendByPR, the same figure the board shows, so nothing is counted twice
// (rule 6). Nothing here asks GitHub.

// GitHubPR is one pull request header from a GitHub list (github_prs).
type GitHubPR struct {
	Number    int
	URL       string
	Title     string
	Head      string
	State     string // open | closed | merged
	CreatedAt int64
	MergedAt  int64
	ClosedAt  int64
	UpdatedAt int64
}

// UpsertGitHubPRs keeps the headers of a pull request list just read for
// repo ("owner/name") in github_prs, seen at seenAt (unix ms). A row is
// rewritten only by a read at least as new as the one it holds (GitHub's
// updated_at), so an older list read late never undoes a newer one. One
// transaction, idempotent.
func (s *Store) UpsertGitHubPRs(ctx context.Context, repo string, prs []GitHubPR, seenAt int64) error {
	if repo == "" || len(prs) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO github_prs(repo, number, url, title, head, state, created_at, merged_at, closed_at, updated_at, seen_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(repo, number) DO UPDATE SET
		  url = excluded.url, title = excluded.title, head = excluded.head, state = excluded.state,
		  created_at = excluded.created_at, merged_at = excluded.merged_at, closed_at = excluded.closed_at,
		  updated_at = excluded.updated_at, seen_at = excluded.seen_at
		WHERE excluded.updated_at >= github_prs.updated_at`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, p := range prs {
		if p.Number <= 0 || p.URL == "" {
			continue
		}
		if _, err := stmt.ExecContext(ctx, repo, p.Number, p.URL, p.Title, p.Head, p.State,
			p.CreatedAt, p.MergedAt, p.ClosedAt, p.UpdatedAt, seenAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// KnownPR is a pull request of a repository Caprock knows of locally, and
// the agent work recorded for it.
type KnownPR struct {
	Number int    `json:"number"`
	URL    string `json:"url"`
	Title  string `json:"title,omitempty"`
	// State is open, closed or merged as GitHub last listed it; without a
	// listed header, merged or closed when a session recorded that, else
	// empty (not known: an ended session is not a merged pull request).
	State string `json:"state,omitempty"`
	// At is when it last moved (unix ms): merged, else closed, else its
	// newest activity — GitHub's updated_at or a session's last command on
	// it. A period keeps the pull requests whose At falls in it.
	At    int64   `json:"at"`
	Spend PRSpend `json:"spend"`
	head  string
}

// PRURLPrefix is the address every pull request of repo ("owner/name")
// starts with on github.com.
func PRURLPrefix(repo string) string { return "https://github.com/" + repo + "/pull/" }

// KnownPRs is every pull request of repo ("owner/name") in github_prs or
// session_prs, each charged by SpendByPR over the sessions of repoRoot, the
// same way the board charges its cards. For a head branch two share, the
// open one owns it, else the most recently moved (SpendByPR's order). The
// order is by number, newest first.
func KnownPRs(ctx context.Context, q Querier, repoRoot, repo string) ([]KnownPR, error) {
	if repo == "" {
		return nil, nil
	}
	byURL := map[string]*KnownPR{}
	var all []*KnownPR
	rows, err := q.QueryContext(ctx, `
		SELECT number, url, title, head, state, merged_at, closed_at, updated_at
		FROM github_prs WHERE repo = ?`, repo)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p KnownPR
		var merged, closed, updated int64
		if err := rows.Scan(&p.Number, &p.URL, &p.Title, &p.head, &p.State, &merged, &closed, &updated); err != nil {
			rows.Close()
			return nil, err
		}
		p.At = movedAt(merged, closed, updated)
		byURL[p.URL] = &p
		all = append(all, &p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	// The agents' own records, one row per pull request: the title a session
	// saw, the latest merge or close, the newest command on it.
	prefix := PRURLPrefix(repo)
	rows, err = q.QueryContext(ctx, `
		SELECT url, MAX(number), MAX(title), MAX(merged_at), MAX(closed_at), MAX(last_at)
		FROM session_prs WHERE lower(substr(url, 1, ?)) = lower(?)
		GROUP BY url`, len(prefix), prefix)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var url, title string
		var number int
		var merged, closed, last int64
		if err := rows.Scan(&url, &number, &title, &merged, &closed, &last); err != nil {
			rows.Close()
			return nil, err
		}
		if n, ok := prNumber(url, prefix); ok {
			number = n
		}
		if number <= 0 {
			continue
		}
		if p := byURL[url]; p != nil {
			// GitHub's header says the state and the stamps; a session's
			// newer command still moves At for an open one.
			if p.Title == "" {
				p.Title = title
			}
			if p.State == "open" && last > p.At {
				p.At = last
			}
			continue
		}
		p := &KnownPR{Number: number, URL: url, Title: title, At: movedAt(merged, closed, last)}
		switch {
		case merged > 0:
			p.State = "merged"
		case closed > 0:
			p.State = "closed"
		}
		byURL[url] = p
		all = append(all, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	// SpendByPR's order: the open ones first, then the most recently moved.
	sort.SliceStable(all, func(a, b int) bool {
		oa, ob := all[a].State == "open", all[b].State == "open"
		if oa != ob {
			return oa
		}
		return all[a].At > all[b].At
	})
	refs := make([]PRRef, len(all))
	for i, p := range all {
		refs[i] = PRRef{URL: p.URL, Branch: p.head}
	}
	spend, err := SpendByPR(ctx, q, repoRoot, refs)
	if err != nil {
		return nil, err
	}
	out := make([]KnownPR, len(all))
	for i, p := range all {
		p.Spend = spend[p.URL]
		if p.Spend.Agents == nil {
			p.Spend.Agents = []string{}
		}
		out[i] = *p
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].Number > out[b].Number })
	return out, nil
}

// movedAt is a pull request's last move: merged, else closed, else active.
func movedAt(merged, closed, active int64) int64 {
	switch {
	case merged > 0:
		return merged
	case closed > 0:
		return closed
	}
	return active
}

// prNumber reads the number off a pull request's address under prefix.
func prNumber(url, prefix string) (int, bool) {
	if len(url) < len(prefix) || !strings.EqualFold(url[:len(prefix)], prefix) {
		return 0, false
	}
	rest := url[len(prefix):]
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	n, err := strconv.Atoi(rest)
	return n, err == nil && n > 0
}
