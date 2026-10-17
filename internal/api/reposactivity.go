package api

import (
	"net/http"
	"time"

	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/projects"
	"github.com/dspv/caprock/internal/store"
)

// ReposActivity is GET /v1/repos/activity: the Now screen's Repos section
// (.ai/04-ui.md § Repos on Now). One row per listed repository with a
// session that has not ended.
type ReposActivity struct {
	Repos []RepoActivityRow `json:"repos"`
	// GitHubConnected says whether the rows' github figures could exist.
	GitHubConnected bool `json:"github_connected"`
}

// RepoActivityRow is one repository: its local git figures, how many
// sessions run in it, and the GitHub figures already kept for it.
type RepoActivityRow struct {
	projects.RepoActivity
	ProjectID int64 `json:"project_id"`
	Sessions  int   `json:"sessions"`
	// GitHub is set only while GitHub is connected and the repository's
	// remote is on GitHub; its fields only from what Caprock already keeps.
	GitHub *RepoGitHub `json:"github,omitempty"`
}

// RepoGitHub is what the deck and the PRs & CI tab already read for a
// repository, however old — read from their caches, so this route sends
// nothing to GitHub. A part nobody read yet is absent.
type RepoGitHub struct {
	Repo string `json:"repo"`
	// Pulls is from the last list of the repository's pull requests (the
	// Branches view, the PRs & CI tab).
	Pulls *RepoGitHubPulls `json:"pulls,omitempty"`
	// CI is from the last list of its newest runs (the PRs & CI tab).
	CI *RepoGitHubCI `json:"ci,omitempty"`
	// Release is from the last answer of the deck's Release view.
	Release *RepoGitHubRelease `json:"release,omitempty"`
}

// RepoGitHubPulls counts the kept list.
type RepoGitHubPulls struct {
	Open int `json:"open"`
	// Merged7 counts those merged in the last 7 local days.
	Merged7     int   `json:"merged_7d"`
	TTMMedianMS int64 `json:"ttm_median_ms,omitempty"`
	Listed      int   `json:"listed"`
}

// RepoGitHubCI is github.RunStats over the kept runs, 14 days.
type RepoGitHubCI struct {
	Runs int `json:"runs"`
	Red  int `json:"red"`
	// Workflow and MedianMS are the workflow taking the most time and its
	// median successful run (absent with fewer than two).
	Workflow string `json:"workflow,omitempty"`
	MedianMS int64  `json:"median_ms,omitempty"`
	// Last is the newest run of the kept list, whatever its age.
	Last *RepoGitHubRun `json:"last,omitempty"`
}

// RepoGitHubRun is one run, as a row's expanded line says it.
type RepoGitHubRun struct {
	Name   string `json:"name"`
	Branch string `json:"branch,omitempty"`
	// Status is GitHub's (queued, in_progress, completed…); Conclusion is
	// set once it completed (success, failure, cancelled…).
	Status     string `json:"status"`
	Conclusion string `json:"conclusion,omitempty"`
	At         int64  `json:"at,omitempty"`
	URL        string `json:"url,omitempty"`
}

// RepoGitHubRelease is the newest release run the deck read.
type RepoGitHubRelease struct {
	Tag   string `json:"tag,omitempty"`
	State string `json:"state"`
	At    int64  `json:"at,omitempty"`
}

// reposActivityMax bounds the rows (and so the git reads of one request).
const reposActivityMax = 12

func (s *Server) handleReposActivity(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	ctx := r.Context()
	ps, err := store.ListProjects(ctx, s.d.Store.DB(), false)
	if err != nil {
		s.fail(w, err)
		return
	}
	sess, err := store.ListSessions(ctx, s.d.Store.DB(), true, store.MaxSessionsPage)
	if err != nil {
		s.fail(w, err)
		return
	}
	connected := s.githubConnected()
	out := ReposActivity{Repos: []RepoActivityRow{}, GitHubConnected: connected}
	now := time.Now()
	if s.d.GitHub != nil && s.d.GitHub.Now != nil {
		now = s.d.GitHub.Now()
	}
	for _, p := range ps {
		if p.Kind != store.ProjectKindRepo || len(out.Repos) >= reposActivityMax {
			continue
		}
		n := 0
		for _, x := range sess {
			dir := x.RepoRoot
			if dir == "" {
				dir = x.Cwd
			}
			if dir != "" && store.DirWithin(dir, p.Root) {
				n++
			}
		}
		if n == 0 {
			continue
		}
		row := RepoActivityRow{RepoActivity: s.d.Projects.Activity(ctx, p.Root), ProjectID: p.ID, Sessions: n}
		if p.Name != "" {
			row.Name = p.Name
		}
		if connected {
			remote := p.RemoteURL
			if rc, ok := s.repos.get(ctx, p.Root); ok && rc.URL != "" {
				remote = rc.URL
			}
			row.GitHub = s.keptGitHub(remote, now)
		}
		out.Repos = append(out.Repos, row)
	}
	writeJSON(w, http.StatusOK, out)
}

// newestRun is the run created last, nil for none.
func newestRun(runs []github.CIRun) *RepoGitHubRun {
	var n *github.CIRun
	for i := range runs {
		if n == nil || runs[i].CreatedAt > n.CreatedAt {
			n = &runs[i]
		}
	}
	if n == nil {
		return nil
	}
	at := n.UpdatedAt
	if at == 0 {
		at = n.CreatedAt
	}
	return &RepoGitHubRun{Name: n.Name, Branch: n.HeadBranch, Status: n.Status, Conclusion: n.Conclusion, At: at, URL: n.HTMLURL}
}

// keptGitHub is a repository's GitHub figures from the caches alone.
func (s *Server) keptGitHub(remote string, now time.Time) *RepoGitHub {
	repo, ok := github.ParseRemote(remote)
	if !ok {
		return nil
	}
	g := &RepoGitHub{Repo: repo.FullName()}
	if prs, ok := s.d.GitHub.CachedRepoPulls(repo); ok {
		pl := &RepoGitHubPulls{Listed: len(prs)}
		for _, p := range prs {
			if p.State == "open" {
				pl.Open++
			}
		}
		for _, m := range github.MergesPerDay(prs, now, 7) {
			pl.Merged7 += m
		}
		pl.TTMMedianMS, _ = github.TimeToMerge(prs, now, github.StatsDays)
		g.Pulls = pl
	}
	if runs, ok := s.d.GitHub.CachedRepoRuns(repo); ok {
		st := github.RunStats(runs, now, github.StatsDays)
		ci := &RepoGitHubCI{Runs: st.Runs, Red: st.Red}
		if len(st.Workflows) > 0 {
			ci.Workflow, ci.MedianMS = st.Workflows[0].Name, st.Workflows[0].MedianMS
		}
		ci.Last = newestRun(runs)
		g.CI = ci
	}
	if rel, ok := s.d.GitHub.CachedRelease(repo); ok && rel.State != "" && rel.State != "none" {
		rr := &RepoGitHubRelease{Tag: rel.Tag, State: rel.State}
		if rel.Run != nil {
			rr.At = rel.Run.UpdatedAt
		}
		g.Release = rr
	}
	return g
}
