package api

import (
	"slices"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/relplan"
	"github.com/dspv/caprock/internal/store"
)

// Each open pull request lands in the column its checks, merge state and
// review put it in; a merge into the default branch is released by the
// first release published after it; one before the window is left out.
func TestBuildBoard(t *testing.T) {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	at := func(h time.Duration) int64 { return now.Add(-h).UnixMilli() }
	no := false
	prs := []github.BranchPR{
		{Number: 1, URL: "u1", State: "open", Draft: true, CreatedAt: at(5 * time.Hour)},
		{Number: 2, URL: "u2", State: "open", HeadSHA: "s2", CreatedAt: at(4 * time.Hour)},
		{Number: 3, URL: "u3", State: "open", HeadSHA: "s3", CreatedAt: at(3 * time.Hour)},
		{Number: 4, URL: "u4", State: "open", HeadSHA: "s4", CreatedAt: at(2 * time.Hour)},
		{Number: 5, URL: "u5", State: "open", HeadSHA: "s5", CreatedAt: at(2 * time.Hour)},
		{Number: 6, URL: "u6", State: "open", HeadSHA: "s6", CreatedAt: at(time.Hour)},
		{Number: 7, URL: "u7", State: "merged", Base: "main", CreatedAt: at(30 * time.Hour), MergedAt: at(26 * time.Hour)},
		{Number: 8, URL: "u8", State: "merged", Base: "main", CreatedAt: at(3 * time.Hour), MergedAt: at(2 * time.Hour)},
		{Number: 9, URL: "u9", State: "merged", Base: "release/1", CreatedAt: at(30 * time.Hour), MergedAt: at(25 * time.Hour)},
		{Number: 10, URL: "u10", State: "closed", CreatedAt: at(3 * time.Hour)},
		// #12 closed unmerged yesterday, #13 before the window.
		{Number: 12, URL: "u12", State: "closed", CreatedAt: at(30 * time.Hour), ClosedAt: at(27 * time.Hour)},
		{Number: 13, URL: "u13", State: "closed", CreatedAt: at(30 * 24 * time.Hour), ClosedAt: at(29 * 24 * time.Hour)},
		{Number: 11, URL: "u11", State: "merged", Base: "main", CreatedAt: at(40 * 24 * time.Hour), MergedAt: at(39 * 24 * time.Hour)},
	}
	live := map[int]github.PR{
		// #2: a check failed an hour ago.
		2: {Number: 2, Checks: github.Checks{State: "fail", Items: []github.Check{{Name: "test (windows)", State: "fail", StartedAt: at(80 * time.Minute), CompletedAt: at(time.Hour)}, {Name: "lint", State: "pass"}}}},
		// #3: green, but GitHub says it conflicts.
		3: {Number: 3, Mergeable: &no, Checks: github.Checks{State: "pass"}},
		// #4: running since 10 minutes ago.
		4: {Number: 4, Checks: github.Checks{State: "pending", Items: []github.Check{{StartedAt: at(10 * time.Minute)}}}},
		// #5: green since 20 minutes ago.
		5: {Number: 5, Checks: github.Checks{State: "pass", Items: []github.Check{{StartedAt: at(30 * time.Minute), CompletedAt: at(20 * time.Minute)}}}},
	}
	// #6 has no live read: its state comes from the runs list.
	runs := []github.CIRun{{HeadSHA: "s6", Status: "in_progress", StartedAt: at(5 * time.Minute)}}
	rels := []github.RepoRelease{{Tag: "v2", PublishedAt: at(24 * time.Hour)}, {Tag: "v1", PublishedAt: at(48 * time.Hour)}}
	spend := map[string]store.PRSpend{"u7": {CostUSD: 4, Sessions: 2}, "u4": {CostUSD: 1.5, Sessions: 1, Live: 1, Agents: []string{"claude"}},
		"u12": {CostUSD: 2.25, Sessions: 1}, "u13": {CostUSD: 9, Sessions: 1}}
	b := buildBoard(boardInput{prs: prs, live: live, runs: runs, releases: rels, defaultBranch: "main", spend: spend, now: now, days: 14})

	got := map[int]BoardCard{}
	for _, c := range b.Cards {
		got[c.Number] = c
	}
	want := map[int]string{1: StageDraft, 2: StageFix, 3: StageFix, 4: StageOpen, 5: StageReady, 6: StageOpen, 7: StageReleased, 8: StageMerged, 9: StageMerged}
	for n, st := range want {
		if got[n].Stage != st {
			t.Errorf("#%d stage %q, want %q", n, got[n].Stage, st)
		}
	}
	if _, ok := got[10]; ok {
		t.Error("a closed pull request is on the board")
	}
	if _, ok := got[11]; ok {
		t.Error("a merge before the window is on the board")
	}
	if got[2].Why != "ci" || got[2].StageAt != at(time.Hour) || got[3].Why != "conflict" {
		t.Errorf("fix: %+v %+v", got[2], got[3])
	}
	if !slices.Equal(got[2].Failed, []string{"test (windows)"}) || got[3].Failed != nil {
		t.Errorf("failed checks: %v %v", got[2].Failed, got[3].Failed)
	}
	if got[2].CIMS != (20*time.Minute).Milliseconds() || got[5].CIMS != (10*time.Minute).Milliseconds() || got[4].CIMS != 0 {
		t.Errorf("CI time: %d %d %d", got[2].CIMS, got[5].CIMS, got[4].CIMS)
	}
	if len(got[2].OS) != 1 || got[2].OS[0] != (BoardOS{OS: "windows", State: "fail", Checks: 1}) || got[3].OS != nil {
		t.Errorf("checks by OS: %+v %+v", got[2].OS, got[3].OS)
	}
	if got[4].CI != "running" || got[4].StageAt != at(10*time.Minute) || got[4].Spend.Live != 1 || got[6].CI != "running" {
		t.Errorf("running: %+v %+v", got[4], got[6])
	}
	if got[5].StageAt != at(20*time.Minute) || got[7].Release != "v2" || got[7].StageAt != at(24*time.Hour) {
		t.Errorf("ready, released: %+v %+v", got[5], got[7])
	}
	if b.Cards[0].Number != 1 || b.Cards[len(b.Cards)-1].Number != 7 {
		t.Errorf("order: %+v", b.Cards)
	}
	if len(b.Releases) != 2 || b.Releases[0].Tag != "v2" || len(b.Releases[0].PRs) != 1 || b.Releases[0].CostUSD != 4 || b.Releases[0].Sessions != 2 {
		t.Errorf("releases: %+v", b.Releases)
	}
	// v1 is the oldest read: nothing says the list reaches back before it.
	if !b.Releases[1].Partial || b.Releases[0].Partial {
		t.Errorf("partial: %+v", b.Releases)
	}
	// #11 merged before v1 too, outside the window, but v1 is its release.
	if len(b.Releases[1].PRs) != 1 || b.Releases[1].PRs[0] != 11 {
		t.Errorf("v1: %+v", b.Releases[1])
	}
	// The closed unmerged one in the window is on no stage, but its cost is
	// the window's (owner, 2026-10-24: $29.89 in flight, $0.00 in the figure).
	if b.Flow.Counts[StageFix] != 2 || b.Flow.Merged != 3 || b.Flow.ReleaseLagCount != 1 || b.Flow.ReleaseLagMedianMS != 0 || b.Flow.CostUSD != 7.75 {
		t.Errorf("flow: %+v", b.Flow)
	}
	if _, ok := got[12]; ok {
		t.Error("a closed pull request is on the board")
	}
	if len(b.Closed) != 1 || b.Closed[0].Number != 12 || b.Closed[0].Spend.CostUSD != 2.25 || b.Closed[0].ClosedAt != at(27*time.Hour) {
		t.Errorf("closed: %+v", b.Closed)
	}
}

// One the list says open and its live read says closed leaves the stages,
// its cost kept as closed.
func TestBoardClosedByLiveRead(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	prs := []github.BranchPR{{Number: 796, URL: "u", State: "open", CreatedAt: now.Add(-30 * time.Hour).UnixMilli()}}
	b := buildBoard(boardInput{prs: prs, live: map[int]github.PR{796: {Number: 796, State: "closed"}}, spend: map[string]store.PRSpend{"u": {CostUSD: 3, Sessions: 1}}, now: now, days: 14})
	if len(b.Cards) != 0 || len(b.Closed) != 1 || b.Flow.CostUSD != 3 {
		t.Errorf("cards %+v, closed %+v, cost %v", b.Cards, b.Closed, b.Flow.CostUSD)
	}
}

// How often the repository ships: the median gap between consecutive
// releases already read, with at least three gaps; never a date.
func TestBoardReleaseGap(t *testing.T) {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	day := 24 * time.Hour
	rel := func(tag string, daysAgo int) github.RepoRelease {
		return github.RepoRelease{Tag: tag, PublishedAt: now.Add(-time.Duration(daysAgo) * day).UnixMilli()}
	}
	// Two gaps: the count, no median. The two releases from the earlier
	// test's board already said nothing either.
	b := buildBoard(boardInput{releases: []github.RepoRelease{rel("v3", 1), rel("v2", 3), rel("v1", 4)}, now: now, days: 14})
	if b.Flow.ReleaseGapMedianMS != 0 || b.Flow.ReleaseGapCount != 2 {
		t.Fatalf("two gaps: %+v", b.Flow)
	}
	// Gaps of 1, 2, 4 and 6 days, listed newest first as GitHub does, and
	// one without a stamp, which is skipped: the median is 3 days.
	rels := []github.RepoRelease{rel("v5", 0), rel("v4", 6), {Tag: "draftish"}, rel("v3", 10), rel("v2", 12), rel("v1", 13)}
	b = buildBoard(boardInput{releases: rels, now: now, days: 14})
	if b.Flow.ReleaseGapCount != 4 || b.Flow.ReleaseGapMedianMS != (3*day).Milliseconds() {
		t.Fatalf("four gaps: %+v", b.Flow)
	}
}

// A check's OS is read from its name as a matrix job names it; each OS is
// failed, running since its earliest unfinished check, or passed.
func TestChecksByOS(t *testing.T) {
	got := checksByOS([]github.Check{
		{Name: "go (ubuntu-latest)", State: "pass"},
		{Name: "go (macos-14)", State: "pending", StartedAt: 20},
		{Name: "ui (macos-14)", State: "pending", StartedAt: 10},
		{Name: "go (windows-latest)", State: "fail"},
		{Name: "e2e (windows-latest)", State: "pending", StartedAt: 5},
		{Name: "lint", State: "pass"},
		{Name: "darwin build (macos)", State: "skipped"},
		{Name: "winget manifest", State: "pass"},
	})
	want := []BoardOS{
		{OS: "linux", State: "pass", Checks: 1},
		{OS: "macos", State: "running", Since: 10, Checks: 2},
		{OS: "windows", State: "fail", Checks: 2},
	}
	if !slices.Equal(got, want) {
		t.Errorf("by OS:\n got %+v\nwant %+v", got, want)
	}
	if checksByOS([]github.Check{{Name: "lint", State: "pass"}}) != nil {
		t.Error("checks naming no OS give OS entries")
	}
}

// How merged work ships (owner, 2026-10-18): a release or a version tag in
// the last 180 days says releases; neither, with both read, says the merge
// is the last step; a read that failed says nothing.
func TestBoardShipsBy(t *testing.T) {
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	ago := func(days int) int64 { return now.AddDate(0, 0, -days).UnixMilli() }
	cases := []struct {
		name string
		in   boardInput
		want string
	}{
		{"a recent release", boardInput{releases: []github.RepoRelease{{Tag: "v0.132.0", PublishedAt: ago(1)}}, releasesRead: true}, ShipsByRelease},
		{"a recent version tag, no GitHub release", boardInput{releasesRead: true, tags: []relplan.Tag{{Name: "v1.4.0", At: ago(30)}}, tagsRead: true}, ShipsByRelease},
		{"a recent release, the tags unread", boardInput{releases: []github.RepoRelease{{Tag: "v2", PublishedAt: ago(10)}}, releasesRead: true}, ShipsByRelease},
		{"nothing at all: a site deployed on merge", boardInput{releasesRead: true, tagsRead: true}, ShipsByMerge},
		{"only old releases and tags", boardInput{releases: []github.RepoRelease{{Tag: "v1.0.0", PublishedAt: ago(400)}}, releasesRead: true, tags: []relplan.Tag{{Name: "v1.0.0", At: ago(400)}}, tagsRead: true}, ShipsByMerge},
		{"a recent tag that names no version", boardInput{releasesRead: true, tags: []relplan.Tag{{Name: "deploy-ok", At: ago(1)}}, tagsRead: true}, ShipsByMerge},
		{"the release list unread", boardInput{tagsRead: true}, ""},
		{"the tags unread", boardInput{releasesRead: true}, ""},
	}
	for _, c := range cases {
		c.in.now, c.in.days = now, 14
		if got := buildBoard(c.in).ShipsBy; got != c.want {
			t.Errorf("%s: ships_by %q, want %q", c.name, got, c.want)
		}
	}
}
