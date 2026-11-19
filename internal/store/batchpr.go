package store

import (
	"context"
	"regexp"
	"strings"
)

// The right panel's release notes read the changelog fragments the open
// batch pull request carries before it merges (owner, 2026-11-19): which pull
// request that is comes from the headers of the GitHub lists the daemon
// already read (github_prs, migration 0071). Nothing here asks GitHub.

// releaseTitle is a release pull request's title ("chore(release): 0.183.0",
// "release: v1.2.3"): never the batch.
var releaseTitle = regexp.MustCompile(`(?i)^(?:chore\(release\)|release)!?\s*:?\s*v?\d+\.\d+\.\d+\b`)

// batchScan is how many of the newest open pull requests are looked at.
const batchScan = 20

// BatchPR is the newest open pull request of repo ("owner/name") that is not
// a release pull request and has a head branch, as GitHub last listed it,
// seen at or after since (unix ms). ok is false when there is none.
func BatchPR(ctx context.Context, q Querier, repo string, since int64) (GitHubPR, bool, error) {
	if repo == "" {
		return GitHubPR{}, false, nil
	}
	rows, err := q.QueryContext(ctx, `
		SELECT number, url, title, head, created_at, updated_at FROM github_prs
		WHERE repo = ? AND state = 'open' AND seen_at >= ?
		ORDER BY number DESC LIMIT ?`, repo, since, batchScan)
	if err != nil {
		return GitHubPR{}, false, err
	}
	defer rows.Close()
	for rows.Next() {
		p := GitHubPR{State: "open"}
		if err := rows.Scan(&p.Number, &p.URL, &p.Title, &p.Head, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return GitHubPR{}, false, err
		}
		if p.Head == "" || releaseTitle.MatchString(strings.TrimSpace(p.Title)) {
			continue
		}
		return p, true, rows.Err()
	}
	return GitHubPR{}, false, rows.Err()
}
