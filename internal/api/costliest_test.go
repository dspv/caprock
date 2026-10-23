package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/gitremote"
	"github.com/dspv/caprock/internal/store"
)

// The Most expensive section over a period, from this machine alone: the
// pull requests agents recorded, the releases the checkout's version tags
// mark, each release the sum of its pull requests' figures. Nothing is asked
// of GitHub, connected or not.
func TestSessionCostliest(t *testing.T) {
	asked := 0
	s, _, _, repo, _, _ := githubServer(t, func(w http.ResponseWriter, _ *http.Request) { asked++; w.WriteHeader(http.StatusNotFound) })
	ctx := context.Background()
	now := time.Now()
	git := func(at time.Time, args ...string) {
		t.Helper()
		c := exec.Command("git", append([]string{"-C", repo}, args...)...)
		stamp := at.Format(time.RFC3339)
		c.Env = append(s.d.Projects.Env(), "GIT_AUTHOR_DATE="+stamp, "GIT_COMMITTER_DATE="+stamp)
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	old := now.Add(-60 * 24 * time.Hour)
	git(old, "commit", "-q", "--allow-empty", "-m", "feat: one (#1)")
	git(old, "commit", "-q", "--allow-empty", "-m", "fix: two (#2)")
	git(old, "tag", "v1.0.0")
	git(now.Add(-time.Hour), "commit", "-q", "--allow-empty", "-m", "Merge pull request #3 from ada/feat-three")
	git(now.Add(-time.Hour), "tag", "v1.1.0")
	git(now.Add(-time.Hour), "tag", "v1.2.0-rc.1") // not a release

	if err := store.UpsertSession(ctx, s.d.Store.DB(), "s1", store.SessionPatch{Cwd: repo, Agent: "claude", StartedAt: 1000, LastEventAt: 2000}); err != nil {
		t.Fatal(err)
	}
	q := s.d.Store.DB()
	for _, x := range []struct {
		id     string
		cost   float64
		url    string
		n      int
		merged int64
	}{
		{"a", 10, "https://github.com/ada/repo/pull/1", 1, old.UnixMilli()},
		{"b", 4, "https://github.com/ada/repo/pull/3", 3, now.Add(-2 * time.Hour).UnixMilli()},
		{"c", 99, "https://github.com/ada/other/pull/3", 3, now.UnixMilli()}, // another repository
	} {
		if _, err := q.ExecContext(ctx, `INSERT INTO sessions(session_id, cwd, status, repo_root, agent) VALUES(?,?,?,?,?)`, x.id, repo, "ended", repo, "claude"); err != nil {
			t.Fatal(err)
		}
		if _, err := q.ExecContext(ctx, `INSERT INTO session_stats(session_id, cost_usd) VALUES(?,?)`, x.id, x.cost); err != nil {
			t.Fatal(err)
		}
		if _, err := q.ExecContext(ctx, `INSERT INTO session_prs(session_id, url, number, title, opened_at, merged_at, last_at) VALUES(?,?,?,?,?,?,?)`,
			x.id, x.url, x.n, "PR", x.merged-1000, x.merged, x.merged); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := q.ExecContext(ctx, `UPDATE sessions SET repo_root = ? WHERE session_id = 's1'`, repo); err != nil {
		t.Fatal(err)
	}
	s.repos.lookup = func(_ context.Context, dir string) (gitremote.Repo, bool) {
		return gitremote.Repo{Root: dir, URL: "https://github.com/ada/repo"}, true
	}
	read := func(query string) Costliest {
		t.Helper()
		w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci/costliest"+query, "")
		var got Costliest
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", query, w.Code, w.Body.String())
		}
		return got
	}

	all := read("?days=all")
	if all.Days != 0 || all.Since != 0 || all.Repo != "ada/repo" || all.PRsKnown != 2 || all.PRsCounted != 2 || !all.TagsRead {
		t.Fatalf("all time: %+v", all)
	}
	if len(all.PRs) != 2 || all.PRs[0].Number != 1 || all.PRs[0].Spend.CostUSD != 10 || all.PRs[1].Number != 3 || all.PRs[1].State != "merged" {
		t.Fatalf("all time, pull requests: %+v", all.PRs)
	}
	if all.ReleasesCounted != 2 || len(all.Releases) != 2 {
		t.Fatalf("all time, releases: %+v", all.Releases)
	}
	r0, r1 := all.Releases[0], all.Releases[1]
	if r0.Tag != "v1.0.0" || r0.CostUSD != 10 || len(r0.PRs) != 2 || !r0.First || r0.URL != "https://github.com/ada/repo/releases/tag/v1.0.0" {
		t.Fatalf("v1.0.0: %+v", r0)
	}
	if r1.Tag != "v1.1.0" || r1.CostUSD != 4 || r1.Sessions != 1 || len(r1.PRs) != 1 || r1.PRs[0] != 3 || r1.First {
		t.Fatalf("v1.1.0: %+v", r1)
	}

	// Asked without a period: the last 30 days.
	month := read("")
	if month.Days != 30 || month.Since <= 0 || len(month.PRs) != 1 || month.PRs[0].Number != 3 || month.PRsCounted != 1 ||
		len(month.Releases) != 1 || month.Releases[0].Tag != "v1.1.0" || month.ReleasesCounted != 1 {
		t.Fatalf("30 days: %+v", month)
	}
	if got := read("?days=14"); got.Days != 14 || len(got.PRs) != 1 {
		t.Fatalf("14 days: %+v", got)
	}
	if w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci/costliest?days=7", ""); w.Code != http.StatusBadRequest {
		t.Fatalf("days=7: %d", w.Code)
	}
	if asked != 0 {
		t.Fatalf("GitHub was asked %d times", asked)
	}

	// A tag made since shows once the history's key is read again, at most
	// relHistRecheck later; the git reads are not repeated before that.
	clock := time.Now().Add(relHistRecheck) // past the reads above
	s.relHist.now = func() time.Time { return clock }
	git(now, "commit", "-q", "--allow-empty", "-m", "feat: four (#4)")
	git(now, "tag", "v1.3.0")
	rels, err := s.relHist.history(ctx, repo)
	if err != nil || len(rels) != 3 || rels[0].Tag != "v1.3.0" {
		t.Fatalf("first read with the clock: %+v %v", rels, err)
	}
	git(now, "commit", "-q", "--allow-empty", "-m", "feat: five (#5)")
	git(now, "tag", "v1.4.0")
	if rels, _ := s.relHist.history(ctx, repo); len(rels) != 3 {
		t.Fatalf("read again before relHistRecheck: %+v", rels)
	}
	clock = clock.Add(relHistRecheck)
	if rels, _ := s.relHist.history(ctx, repo); len(rels) != 4 || rels[0].Tag != "v1.4.0" || rels[0].PRs[0] != 5 {
		t.Fatalf("after relHistRecheck: %+v", rels)
	}
}

// Dearest first, five at most; a tie goes to more sessions (pull requests)
// or more pull requests (releases), then the newer; a release with no cost
// is left out.
func TestCostliestRanking(t *testing.T) {
	pr := func(n int, cost float64, sessions int) store.KnownPR {
		return store.KnownPR{Number: n, Spend: store.PRSpend{CostUSD: cost, Sessions: sessions}}
	}
	got := topKnownPRs([]store.KnownPR{pr(10, 4, 1), pr(11, 4, 3), pr(12, 4, 1), pr(1, 9, 1), pr(2, 1, 1), pr(3, 0.5, 1), pr(4, 0.1, 1)}, 5)
	want := []int{1, 11, 12, 10, 2}
	if len(got) != len(want) {
		t.Fatalf("%+v", got)
	}
	for i, n := range want {
		if got[i].Number != n {
			t.Fatalf("order %+v, want %v", got, want)
		}
	}
	if got := topKnownPRs(nil, 5); got == nil || len(got) != 0 {
		t.Fatalf("none: %#v", got)
	}
	rel := func(tag string, cost float64, prs []int, at int64) CostlyRelease {
		return CostlyRelease{Tag: tag, CostUSD: cost, Sessions: len(prs), PRs: prs, At: at}
	}
	rels := topCostlyReleases([]CostlyRelease{
		rel("v1.6.0", 2, []int{6}, 600), rel("v1.5.0", 9, []int{5, 4}, 500), rel("v1.4.0", 0, nil, 400),
		rel("v1.3.0", 2, []int{3, 2}, 300), rel("v1.2.0", 2, []int{1}, 200), rel("v1.1.0", 1, []int{8}, 100), rel("v1.0.0", 0.5, []int{9}, 50),
	}, 5)
	var tags []string
	for _, r := range rels {
		tags = append(tags, r.Tag)
	}
	if got, want := strings.Join(tags, " "), "v1.5.0 v1.3.0 v1.6.0 v1.2.0 v1.1.0"; got != want {
		t.Fatalf("releases %q, want %q", got, want)
	}
}
