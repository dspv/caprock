package store

import (
	"context"
	"errors"
	"sort"
)

// ErrNotMultiRepo is returned when a multi-repo action meets a project with
// no member repositories.
var ErrNotMultiRepo = errors.New("this project is not a multi-repo project")

// ProjectRepos lists the member repositories of every multi-repo project
// (migration 0050, ADR-055), keyed by project id, each list sorted by path.
func ProjectRepos(ctx context.Context, q Querier) (map[int64][]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT project_id, path FROM project_repos ORDER BY project_id, path`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][]string{}
	for rows.Next() {
		var id int64
		var p string
		if err := rows.Scan(&id, &p); err != nil {
			return nil, err
		}
		out[id] = append(out[id], p)
	}
	return out, rows.Err()
}

// CleanRepoPaths normalises paths, drops empties and duplicates, and sorts
// them: the form project_repos keeps.
func CleanRepoPaths(paths []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, p := range paths {
		n := NormalizeDir(p)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// SetProjectRepos replaces project id's member repositories with paths
// (CleanRepoPaths). A repository is a member of one project at a time: a
// path another project held moves here. An empty list makes the project an
// ordinary one again. Nothing on disk is touched. Run it inside a
// transaction (Store.WithTx) so a move is never half done.
func SetProjectRepos(ctx context.Context, q Querier, id int64, paths []string, at int64) ([]string, error) {
	norm := CleanRepoPaths(paths)
	if _, err := GetProject(ctx, q, id); err != nil {
		return nil, err
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM project_repos WHERE project_id = ?`, id); err != nil {
		return nil, err
	}
	for _, p := range norm {
		if _, err := q.ExecContext(ctx, `DELETE FROM project_repos WHERE path = ?`, p); err != nil {
			return nil, err
		}
		if _, err := q.ExecContext(ctx, `INSERT INTO project_repos(project_id, path, added_at) VALUES (?, ?, ?)`, id, p, at); err != nil {
			return nil, err
		}
	}
	return norm, nil
}
