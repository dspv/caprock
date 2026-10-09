package store

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Project is one row of the projects list (migration 0041).
type Project struct {
	ID            int64  `json:"id"`
	Root          string `json:"root"`
	Name          string `json:"name"`
	Kind          string `json:"kind"`   // repo | folder
	Source        string `json:"source"` // seed | session | folder | new | clone
	RemoteURL     string `json:"remote_url,omitempty"`
	DefaultBranch string `json:"default_branch,omitempty"`
	AddedAt       int64  `json:"added_at"`
	Pinned        bool   `json:"pinned"`
	Sort          int64  `json:"sort"`
	Defaults      string `json:"-"` // raw JSON; the API decodes it
	ArchivedAt    int64  `json:"archived_at,omitempty"`
}

// Project kinds and sources, as the CHECK constraints spell them.
const (
	ProjectKindRepo   = "repo"
	ProjectKindFolder = "folder"

	ProjectSourceSeed    = "seed"
	ProjectSourceSession = "session"
	ProjectSourceFolder  = "folder"
	ProjectSourceNew     = "new"
	ProjectSourceClone   = "clone"
)

// MetaProjectsSeeded is "1" once the projects list has been seeded from the
// repositories sessions ran in.
const MetaProjectsSeeded = "projects_seeded"

// ErrProjectNotFound is returned for an id no row has.
var ErrProjectNotFound = errors.New("no such project")

const projectCols = `id, root, name, kind, source, remote_url, default_branch, added_at, pinned, sort, defaults, COALESCE(archived_at, 0)`

func scanProject(sc interface{ Scan(...any) error }) (Project, error) {
	var p Project
	var pinned int
	err := sc.Scan(&p.ID, &p.Root, &p.Name, &p.Kind, &p.Source, &p.RemoteURL, &p.DefaultBranch, &p.AddedAt, &pinned, &p.Sort, &p.Defaults, &p.ArchivedAt)
	p.Pinned = pinned == 1
	return p, err
}

// ListProjects returns the listed projects (archived ones too when
// withArchived), pinned first, then by sort, then by name.
func ListProjects(ctx context.Context, q Querier, withArchived bool) ([]Project, error) {
	where := ` WHERE archived_at IS NULL`
	if withArchived {
		where = ``
	}
	rows, err := q.QueryContext(ctx, `SELECT `+projectCols+` FROM projects`+where+` ORDER BY pinned DESC, sort, name COLLATE NOCASE, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Project
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetProject returns one project by id, archived or not.
func GetProject(ctx context.Context, q Querier, id int64) (Project, error) {
	p, err := scanProject(q.QueryRowContext(ctx, `SELECT `+projectCols+` FROM projects WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrProjectNotFound
	}
	return p, err
}

// GetProjectByRoot returns the project whose root is root, archived or not.
func GetProjectByRoot(ctx context.Context, q Querier, root string) (Project, error) {
	p, err := scanProject(q.QueryRowContext(ctx, `SELECT `+projectCols+` FROM projects WHERE root = ?`, NormalizeDir(root)))
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrProjectNotFound
	}
	return p, err
}

// InsertProject adds p, or — when its root is already a row — lists that row
// again (an add of an unlisted project brings it back) and returns it. The
// existing row's name and settings are kept.
func InsertProject(ctx context.Context, q Querier, p Project) (Project, bool, error) {
	p.Root = NormalizeDir(p.Root)
	if p.Defaults == "" {
		p.Defaults = "{}"
	}
	res, err := q.ExecContext(ctx, `INSERT INTO projects(root, name, kind, source, remote_url, default_branch, added_at, defaults)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(root) DO NOTHING`,
		p.Root, p.Name, p.Kind, p.Source, p.RemoteURL, p.DefaultBranch, p.AddedAt, p.Defaults)
	if err != nil {
		return Project{}, false, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		if _, err := q.ExecContext(ctx, `UPDATE projects SET archived_at = NULL WHERE root = ?`, p.Root); err != nil {
			return Project{}, false, err
		}
	}
	got, err := GetProjectByRoot(ctx, q, p.Root)
	return got, n > 0, err
}

// SeedProject adds a project found from sessions, unless its root is already
// a row — listed or unlisted, so an unlisted project stays off the list.
// Reports whether a row was added.
func SeedProject(ctx context.Context, q Querier, p Project) (bool, error) {
	res, err := q.ExecContext(ctx, `INSERT INTO projects(root, name, kind, source, remote_url, default_branch, added_at, defaults)
		VALUES (?, ?, ?, ?, ?, ?, ?, '{}') ON CONFLICT(root) DO NOTHING`,
		NormalizeDir(p.Root), p.Name, p.Kind, p.Source, p.RemoteURL, p.DefaultBranch, p.AddedAt)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ProjectPatch is what PATCH /v1/projects/{id} may change; nil leaves a field.
type ProjectPatch struct {
	Name     *string
	Pinned   *bool
	Sort     *int64
	Defaults *string
}

// UpdateProject applies patch to project id.
func UpdateProject(ctx context.Context, q Querier, id int64, patch ProjectPatch) error {
	var sets []string
	var args []any
	if patch.Name != nil {
		sets, args = append(sets, "name = ?"), append(args, *patch.Name)
	}
	if patch.Pinned != nil {
		pinned := 0
		if *patch.Pinned {
			pinned = 1
		}
		sets, args = append(sets, "pinned = ?"), append(args, pinned)
	}
	if patch.Sort != nil {
		sets, args = append(sets, "sort = ?"), append(args, *patch.Sort)
	}
	if patch.Defaults != nil {
		sets, args = append(sets, "defaults = ?"), append(args, *patch.Defaults)
	}
	if len(sets) == 0 {
		_, err := GetProject(ctx, q, id)
		return err
	}
	args = append(args, id)
	res, err := q.ExecContext(ctx, `UPDATE projects SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrProjectNotFound
	}
	return nil
}

// SetProjectGit records what git says a project's remote and default branch
// are, when they changed.
func SetProjectGit(ctx context.Context, q Querier, id int64, remoteURL, defaultBranch string) error {
	_, err := q.ExecContext(ctx, `UPDATE projects SET remote_url = ?, default_branch = ? WHERE id = ? AND (remote_url != ? OR default_branch != ?)`,
		remoteURL, defaultBranch, id, remoteURL, defaultBranch)
	return err
}

// ArchiveProject takes a project off the list. Nothing on disk is touched.
func ArchiveProject(ctx context.Context, q Querier, id int64, at int64) error {
	res, err := q.ExecContext(ctx, `UPDATE projects SET archived_at = ? WHERE id = ?`, at, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrProjectNotFound
	}
	return nil
}

// ProjectActivity is what sessions say about one directory key — a
// repository root, or the cwd of a session outside any repository.
type ProjectActivity struct {
	Dir          string
	Total        int64
	Live         int64
	Waiting      int64
	LastActivity int64
	CostToday    float64
}

// ProjectActivityByDir aggregates sessions and today's spend by directory key
// (the repository root, else the cwd), the same key RecentDirs groups by.
// The caller attributes each key to the project that contains it.
//
// Live is a session not ended; waiting is a live one whose newest event is a
// permission prompt, or a main-thread Stop with no subagent still working
// (LiveSubagents) — what narrate calls waiting-on-you. Spend is events at or after sinceMs, internal ones left out
// as every total leaves them out.
func ProjectActivityByDir(ctx context.Context, q Querier, sinceMs int64) (map[string]*ProjectActivity, error) {
	out := map[string]*ProjectActivity{}
	get := func(d string) *ProjectActivity {
		a, ok := out[d]
		if !ok {
			a = &ProjectActivity{Dir: d}
			out[d] = a
		}
		return a
	}
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(NULLIF(repo_root,''), cwd) AS d, COUNT(*),
		       SUM(CASE WHEN status != 'ended' THEN 1 ELSE 0 END),
		       COALESCE(MAX(last_event_at), 0)
		FROM sessions WHERE COALESCE(NULLIF(repo_root,''), cwd, '') != ''
		GROUP BY d`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var d string
		var a ProjectActivity
		if err := rows.Scan(&d, &a.Total, &a.Live, &a.LastActivity); err != nil {
			_ = rows.Close()
			return nil, err
		}
		p := get(d)
		p.Total, p.Live, p.LastActivity = a.Total, a.Live, a.LastActivity
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	rows, err = q.QueryContext(ctx, `
		SELECT COALESCE(NULLIF(s.repo_root,''), s.cwd) AS d, s.session_id,
		       (SELECT e.kind || '|' || COALESCE(e.agent_id, '') FROM events e
		        WHERE e.session_id = s.session_id ORDER BY e.ts DESC, e.id DESC LIMIT 1)
		FROM sessions s WHERE s.status != 'ended' AND COALESCE(NULLIF(s.repo_root,''), s.cwd, '') != ''`)
	if err != nil {
		return nil, err
	}
	// A turn that ended with subagents still at work is not waiting on
	// anyone: Claude Code resumes the parent when they finish. Counted after
	// the rows are closed, so the two queries never hold one connection.
	type stoppedSession struct{ dir, id string }
	var stopped []stoppedSession
	for rows.Next() {
		var d, id string
		var last sql.NullString
		if err := rows.Scan(&d, &id, &last); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if strings.HasPrefix(last.String, "permission.prompt|") {
			get(d).Waiting++
			continue
		}
		if last.String == "agent.stop|" {
			stopped = append(stopped, stoppedSession{dir: d, id: id})
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for _, st := range stopped {
		n, err := LiveSubagents(ctx, q, st.id, nowMs()-LiveSubagentWindow.Milliseconds())
		if err != nil {
			return nil, err
		}
		if n == 0 {
			get(st.dir).Waiting++
		}
	}
	rows, err = q.QueryContext(ctx, `
		SELECT COALESCE(NULLIF(s.repo_root,''), s.cwd) AS d, COALESCE(SUM(e.cost_usd), 0)
		FROM events e JOIN sessions s ON s.session_id = e.session_id
		WHERE e.ts >= ?`+nonInternalEventE+` AND e.cost_usd IS NOT NULL
		GROUP BY d`, sinceMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var d string
		var usd float64
		if err := rows.Scan(&d, &usd); err != nil {
			return nil, err
		}
		if d != "" {
			get(d).CostToday += usd
		}
	}
	return out, rows.Err()
}

// SessionRepoRoots lists the repository roots sessions ran in, most recently
// active first — the candidates for seeding the projects list. The caller
// decides which are worth listing (ProjectWorthListing).
func SessionRepoRoots(ctx context.Context, q Querier) ([]RecentDirDetail, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT repo_root, COUNT(*), MAX(last_event_at) FROM sessions
		WHERE COALESCE(repo_root, '') != '' GROUP BY repo_root ORDER BY 3 DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RecentDirDetail
	for rows.Next() {
		var d RecentDirDetail
		if err := rows.Scan(&d.Dir, &d.Sessions, &d.LastEventAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ProjectWorthListing reports whether a repository root found from sessions
// should be on the projects list without anyone adding it: still on disk with
// a `.git` directory of its own (not a linked worktree, not a Caprock agent
// worktree), and not a place nobody works in (NotAProject) or a temp
// directory's scratch repository.
func ProjectWorthListing(root string) bool {
	if NotAProject(root) || UnderTempDir(root) || strings.Contains(NormalizeDir(root), "/"+WorktreeDir+"/") {
		return false
	}
	st, err := os.Stat(filepath.Join(filepath.FromSlash(root), ".git"))
	return err == nil && st.IsDir()
}

// UnderTempDir reports whether dir is inside a temp directory: the scratch
// repositories tests and agents make there are not projects.
func UnderTempDir(dir string) bool {
	d := NormalizeDir(dir)
	for _, t := range DefaultTempDirs() {
		if t = NormalizeDir(t); t != "" && hasPathPrefix(d, t) {
			return true
		}
	}
	return false
}

// NormalizeDir puts a directory into the one form the store keeps paths in:
// forward slashes, no trailing separator (sessions.repo_root, projects.root).
func NormalizeDir(dir string) string { return normalizeCwd(dir) }

// DirWithin reports whether dir is root or below it, on segment boundaries.
// Both are normalised first.
func DirWithin(dir, root string) bool {
	return hasPathPrefix(normalizeCwd(dir), normalizeCwd(root))
}

// ResolveRepoRoot is the repository root dir belongs to, read from disk now
// rather than from RepoFromCwd's memo (which keeps a folder's answer for the
// daemon's life, so a `git init` after the first look would be missed), or ""
// when dir is in no repository.
func ResolveRepoRoot(dir string) string {
	return resolveRepo(normalizeCwd(dir)).Root
}
