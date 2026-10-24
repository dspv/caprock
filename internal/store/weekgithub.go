package store

import "context"

// GitHub's record of a window, for the share card (owner, 2026-10-25): the
// card said "5 PRs" in a week GitHub merged 59, because the transcripts only
// see a merge an agent ran by `gh pr merge` — a script's or a batch merge is
// invisible to them. github_prs (migration 0071) already holds the headers of
// every pull request list the Pipeline read, so the week counts from there
// for each repository it knows, and nothing is asked of GitHub here.

// GitHubWindow is what github_prs holds for one repository in a window.
type GitHubWindow struct {
	// Known says github_prs holds any row of the repository at all: a
	// repository the Pipeline never read has no record, which is not "none".
	Known bool
	// Merged are the numbers of the pull requests merged in the window;
	// OpenedAt the creation times (unix ms) of those opened in it.
	Merged   []int
	OpenedAt []int64
}

// GitHubPRsIn reads repo's ("owner/name") pull requests merged and opened in
// [from, to) from github_prs.
func GitHubPRsIn(ctx context.Context, q Querier, repo string, from, to int64) (GitHubWindow, error) {
	var out GitHubWindow
	if repo == "" {
		return out, nil
	}
	var n int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM github_prs WHERE repo = ?`, repo).Scan(&n); err != nil {
		return out, err
	}
	if n == 0 {
		return out, nil
	}
	out.Known = true
	rows, err := q.QueryContext(ctx, `
		SELECT number, created_at, merged_at FROM github_prs
		WHERE repo = ? AND ((merged_at >= ? AND merged_at < ?) OR (created_at >= ? AND created_at < ?))
		ORDER BY number`, repo, from, to, from, to)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var num int
		var created, merged int64
		if err := rows.Scan(&num, &created, &merged); err != nil {
			return out, err
		}
		if merged >= from && merged < to && merged > 0 {
			out.Merged = append(out.Merged, num)
		}
		if created >= from && created < to && created > 0 {
			out.OpenedAt = append(out.OpenedAt, created)
		}
	}
	return out, rows.Err()
}
