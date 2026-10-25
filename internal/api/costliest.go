package api

import (
	"context"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/relplan"
	"github.com/dspv/caprock/internal/store"
)

// The Pipeline's Most expensive section over a period (owner, 2026-10-23,
// translated: "by default a month"): the pull requests and releases of the
// session's repository with the highest recorded agent cost, from what is
// on this machine alone — the pull requests Caprock knows of (session_prs,
// github_prs; store.KnownPRs) and the releases the checkout's version tags
// mark (relplan.ReleaseHistory). Nothing is asked of GitHub. A release costs
// what the pull requests it shipped cost, each the same figure the pull
// request list shows, so no session is counted twice (rule 6).

// costliestShown is how many rows each list carries.
const costliestShown = 5

// costliestPeriods are the periods the section offers, in days; 0 is all
// time.
var costliestPeriods = map[string]int{"14": 14, "30": 30, "all": 0}

// costliestDefault is the period asked without one: the last 30 days.
const costliestDefault = "30"

// Costliest is GET /v1/sessions/{id}/ci/costliest.
type Costliest struct {
	Repo   string `json:"repo,omitempty"`
	Reason string `json:"reason,omitempty"`
	// Days is the period (0 = all time); Since its start (unix ms, 0 for
	// all time): Days local calendar days ending today, as the board's
	// window is counted.
	Days  int   `json:"days"`
	Since int64 `json:"since,omitempty"`
	// PRs are the dearest pull requests that moved in the period (merged,
	// closed or last active), at most costliestShown.
	PRs []store.KnownPR `json:"prs"`
	// PRsCounted is how many pull requests with a recorded cost moved in the
	// period; PRsKnown how many of the repository's Caprock knows at all.
	PRsCounted int `json:"prs_counted"`
	PRsKnown   int `json:"prs_known"`
	// Releases are the dearest releases tagged in the period, at most
	// costliestShown; ReleasesCounted how many were tagged in it.
	Releases        []CostlyRelease `json:"releases"`
	ReleasesCounted int             `json:"releases_counted"`
	// TagsRead says the checkout's tags and history were read: false (no
	// checkout, git failing) is not "no releases".
	TagsRead bool `json:"tags_read"`
	deckFresh
}

func (a Costliest) stamped(f deckFresh) any {
	a.deckFresh = f
	return a
}

// CostlyRelease is one release and what the pull requests it shipped cost.
type CostlyRelease struct {
	Tag string `json:"tag"`
	At  int64  `json:"at"`
	URL string `json:"url"`
	// PRs are the pull requests its commits name.
	PRs     []int   `json:"prs"`
	CostUSD float64 `json:"cost_usd"`
	// Sessions sums its pull requests' sessions: a session cut between two
	// of them counts in each.
	Sessions int `json:"sessions"`
	// Parts splits CostUSD by sign-in: its pull requests' parts summed.
	Parts store.SpendParts `json:"parts,omitempty"`
	// First says it is the oldest release on the line: it shipped
	// everything before it too.
	First bool `json:"first,omitempty"`
}

// relHistCache keeps each checkout's release history while its tags and
// default branch tip stay the same (relplan.HistoryKey), checked again at
// most every relHistRecheck: reading the key alone (every tag peeled and
// dated) was 150 ms of a 300 ms composition on the owner's checkout of
// ~300 tags (2026-10-23). A tag made since shows within that long.
type relHistCache struct {
	mu sync.Mutex
	m  map[string]relHistEntry
	// now is the clock; nil is time.Now (tests set it).
	now func() time.Time
}

type relHistEntry struct {
	key     string
	rels    []relplan.Release
	checked time.Time
}

// relHistMax bounds the checkouts kept; relHistRecheck is how long a
// history is used before its key is read again.
const (
	relHistMax     = 32
	relHistRecheck = 2 * time.Minute
)

func (c *relHistCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

func (c *relHistCache) history(ctx context.Context, dir string) ([]relplan.Release, error) {
	now := c.clock()
	c.mu.Lock()
	e, ok := c.m[dir]
	c.mu.Unlock()
	if ok && now.Sub(e.checked) < relHistRecheck {
		return e.rels, nil
	}
	key, ref, tagsOut, err := relplan.HistoryKey(ctx, dir)
	if err != nil {
		return nil, err
	}
	rels := e.rels
	if !ok || e.key != key {
		if rels, err = relplan.ReleaseHistory(ctx, dir, ref, tagsOut); err != nil {
			return nil, err
		}
	}
	c.mu.Lock()
	if c.m == nil || (len(c.m) >= relHistMax && !ok) {
		c.m = map[string]relHistEntry{}
	}
	c.m[dir] = relHistEntry{key: key, rels: rels, checked: now}
	c.mu.Unlock()
	return rels, nil
}

func (s *Server) handleSessionCostliest(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	period := r.URL.Query().Get("days")
	if period == "" {
		period = costliestDefault
	}
	days, ok := costliestPeriods[period]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "days must be 14, 30 or all"})
		return
	}
	s.serveDeck(w, r, deckKey("costliest:"+period, id, true, 0), func(ctx context.Context) (deckAnswer, error) {
		return s.composeCostliest(ctx, id, days)
	}, s.notFoundOrFail)
}

func (s *Server) composeCostliest(ctx context.Context, id string, days int) (deckAnswer, error) {
	var where SessionRepoCI
	repo, _, ok, err := s.sessionRepo(ctx, id, &where)
	if err != nil {
		return nil, err
	}
	out := Costliest{Repo: where.Repo, Reason: where.Reason, Days: days, PRs: []store.KnownPR{}, Releases: []CostlyRelease{}}
	if !ok {
		return out, nil
	}
	sess, err := store.GetSession(ctx, s.d.Store.DB(), id)
	if err != nil {
		return nil, err
	}
	root := sess.RepoRoot
	if root == "" {
		root = sess.Cwd
	}
	now := time.Now()
	if days > 0 {
		y, m, d := now.Date()
		out.Since = time.Date(y, m, d-(days-1), 0, 0, 0, 0, now.Location()).UnixMilli()
	}
	known, err := store.KnownPRs(ctx, s.d.Store.DB(), root, repo.FullName())
	if err != nil {
		return nil, err
	}
	out.PRsKnown = len(known)
	byNumber := make(map[int]store.KnownPR, len(known))
	var inPeriod []store.KnownPR
	for _, p := range known {
		byNumber[p.Number] = p
		if p.Spend.CostUSD > 0 && p.Spend.Sessions > 0 && p.At >= out.Since {
			inPeriod = append(inPeriod, p)
		}
	}
	out.PRsCounted = len(inPeriod)
	out.PRs = topKnownPRs(inPeriod, costliestShown)

	if root != "" {
		if rels, err := s.relHist.history(ctx, root); err == nil {
			out.TagsRead = true
			var counted []CostlyRelease
			for _, r := range rels {
				if r.At < out.Since {
					continue
				}
				c := CostlyRelease{Tag: r.Tag, At: r.At, URL: "https://github.com/" + repo.FullName() + "/releases/tag/" + r.Tag, PRs: r.PRs, First: r.First}
				if c.PRs == nil {
					c.PRs = []int{}
				}
				for _, n := range r.PRs {
					if p, ok := byNumber[n]; ok {
						c.CostUSD += p.Spend.CostUSD
						c.Sessions += p.Spend.Sessions
						c.Parts = c.Parts.Merge(p.Spend.Parts)
					}
				}
				c.Parts = c.Parts.Sorted()
				counted = append(counted, c)
			}
			out.ReleasesCounted = len(counted)
			out.Releases = topCostlyReleases(counted, costliestShown)
		}
	}
	return out, nil
}

// topKnownPRs is prs by recorded cost, dearest first, at most n: a tie goes
// to more sessions, then the newer number.
func topKnownPRs(prs []store.KnownPR, n int) []store.KnownPR {
	sort.SliceStable(prs, func(a, b int) bool {
		x, y := prs[a], prs[b]
		if x.Spend.CostUSD != y.Spend.CostUSD {
			return x.Spend.CostUSD > y.Spend.CostUSD
		}
		if x.Spend.Sessions != y.Spend.Sessions {
			return x.Spend.Sessions > y.Spend.Sessions
		}
		return x.Number > y.Number
	})
	if len(prs) > n {
		prs = prs[:n]
	}
	if prs == nil {
		return []store.KnownPR{}
	}
	return prs
}

// topCostlyReleases is the releases with a recorded cost, dearest first, at
// most n: a tie goes to more pull requests, then the newer.
func topCostlyReleases(rels []CostlyRelease, n int) []CostlyRelease {
	out := make([]CostlyRelease, 0, len(rels))
	for _, r := range rels {
		if r.CostUSD > 0 && r.Sessions > 0 {
			out = append(out, r)
		}
	}
	sort.SliceStable(out, func(a, b int) bool {
		x, y := out[a], out[b]
		if x.CostUSD != y.CostUSD {
			return x.CostUSD > y.CostUSD
		}
		if len(x.PRs) != len(y.PRs) {
			return len(x.PRs) > len(y.PRs)
		}
		return x.At > y.At
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}
