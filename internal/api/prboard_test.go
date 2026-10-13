package api

import (
	"testing"
	"time"

	"github.com/dspv/caprock/internal/github"
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
		{Number: 11, URL: "u11", State: "merged", Base: "main", CreatedAt: at(40 * 24 * time.Hour), MergedAt: at(39 * 24 * time.Hour)},
	}
	live := map[int]github.PR{
		// #2: a check failed an hour ago.
		2: {Number: 2, Checks: github.Checks{State: "fail", Items: []github.Check{{StartedAt: at(80 * time.Minute), CompletedAt: at(time.Hour)}}}},
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
	spend := map[string]store.PRSpend{"u7": {CostUSD: 4, Sessions: 2}, "u4": {CostUSD: 1.5, Sessions: 1, Live: 1, Agents: []string{"claude"}}}
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
	if b.Flow.Counts[StageFix] != 2 || b.Flow.Merged != 3 || b.Flow.ReleaseLagCount != 1 || b.Flow.ReleaseLagMedianMS != 0 || b.Flow.CostUSD != 5.5 {
		t.Errorf("flow: %+v", b.Flow)
	}
}
