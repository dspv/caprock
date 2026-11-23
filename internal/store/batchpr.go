package store

import (
	"context"
	"regexp"
	"strings"
)

// The right panel's release notes read the changelog fragments the open
// release vehicle carries before it merges (owner, 2026-11-19): which pull
// request that is comes from the headers of the GitHub lists the daemon
// already read (github_prs, migration 0071). Nothing here asks GitHub.
//
// Only a pull request that is one counts (owner, 2026-11-23): the release
// pull request the release opens (head chore/release-X.Y.Z, a title like
// "chore(release): 0.190.1"), else a batch pull request marked as one (head
// batch/…, or a title like "feat: 0.175.0 batch — …"). An ordinary feature
// pull request never does: since each task became its own pull request, the
// newest open one was taken for the batch, and the version and the notes
// counted work that was not on the default branch.

// releaseTitle is a release pull request's title ("chore(release): 0.183.0",
// "release: v1.2.3").
var releaseTitle = regexp.MustCompile(`(?i)^(?:chore\(release\)|release)!?\s*:?\s*v?\d+\.\d+\.\d+\b`)

// batchTitle is a batch pull request's title naming its version ("feat:
// 0.175.0 batch — …").
var batchTitle = regexp.MustCompile(`(?i)\bv?\d+\.\d+\.\d+ batch\b`)

// releaseHead and batchHead are the head branches the release and a batch
// are pushed on.
const (
	releaseHead = "chore/release-"
	batchHead   = "batch/"
)

// batchScan is how many of the newest open pull requests are looked at.
const batchScan = 20

// IsReleasePR says whether a pull request is a release one, by its head
// branch or its title.
func IsReleasePR(title, head string) bool {
	return strings.HasPrefix(head, releaseHead) || releaseTitle.MatchString(strings.TrimSpace(title))
}

// IsBatchPR says whether a pull request is marked as a batch, by its head
// branch or its title.
func IsBatchPR(title, head string) bool {
	return strings.HasPrefix(head, batchHead) || batchTitle.MatchString(title)
}

// BatchPR is the open release vehicle of repo ("owner/name"), as GitHub last
// listed it, seen at or after since (unix ms): the newest open release pull
// request, else the newest open batch pull request, either with a head
// branch. ok is false when there is none — an ordinary pull request is never
// taken for one.
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
	var batch GitHubPR
	found := false
	for rows.Next() {
		p := GitHubPR{State: "open"}
		if err := rows.Scan(&p.Number, &p.URL, &p.Title, &p.Head, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return GitHubPR{}, false, err
		}
		if p.Head == "" {
			continue
		}
		if IsReleasePR(p.Title, p.Head) {
			return p, true, rows.Err()
		}
		if !found && IsBatchPR(p.Title, p.Head) {
			batch, found = p, true
		}
	}
	return batch, found, rows.Err()
}
