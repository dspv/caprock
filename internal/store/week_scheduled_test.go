package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// A session started at a root or in the home directory itself is a
// scheduled script, not hand work: it is left out of every figure and
// counted apart. A folder under home is a project and stays.
func TestWeekStatsLeavesOutScheduledRuns(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	from := time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC)
	home := t.TempDir()
	proj := filepath.Join(home, "dev", "app")
	f.session("hand", "claude", proj)
	f.session("root", "claude", "/")
	f.session("home", "codex", home)
	f.turn("hand", "", from.Add(time.Hour), 2, 0)
	f.turn("root", "", from.Add(2*time.Hour), 30, 0)
	f.turn("home", "", from.Add(3*time.Hour), 40, 0)
	w, err := WeekStats(ctx, f.s.DB(), WeekOptions{From: from, To: from.AddDate(0, 0, 7), Loc: time.UTC, Home: home})
	if err != nil {
		t.Fatal(err)
	}
	if w.Sessions != 1 || w.ScheduledSessions != 2 || w.CostUSD != 2 || w.Turns != 1 || w.Tokens != 20 {
		t.Fatalf("sessions %d scheduled %d cost %v turns %d tokens %d", w.Sessions, w.ScheduledSessions, w.CostUSD, w.Turns, w.Tokens)
	}
	if len(w.Agents) != 1 || w.Agents[0].Agent != "claude" || w.Agents[0].CostUSD != 2 {
		t.Fatalf("agents %+v", w.Agents)
	}
	if w.Biggest != nil && w.Biggest.CostUSD != 2 {
		t.Fatalf("biggest %+v", w.Biggest)
	}
	if len(w.Repos) != 1 || w.Repos[0].CostUSD != 2 {
		t.Fatalf("repos %+v", w.Repos)
	}
}

// github_prs says what it holds; a repository never listed is not known.
func TestGitHubPRsIn(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if gw, err := GitHubPRsIn(ctx, s.DB(), "ada/none", 0, 1<<50); err != nil || gw.Known {
		t.Fatalf("unlisted repository: %+v %v", gw, err)
	}
	if err := s.UpsertGitHubPRs(ctx, "ada/repo", []GitHubPR{
		{Number: 1, URL: "u1", State: "merged", CreatedAt: 50, MergedAt: 150, UpdatedAt: 150},
		{Number: 2, URL: "u2", State: "open", CreatedAt: 120, UpdatedAt: 120},
		{Number: 3, URL: "u3", State: "merged", CreatedAt: 10, MergedAt: 20, UpdatedAt: 20},
	}, 200); err != nil {
		t.Fatal(err)
	}
	gw, err := GitHubPRsIn(ctx, s.DB(), "ADA/repo", 100, 200)
	if err != nil || !gw.Known || len(gw.Merged) != 1 || gw.Merged[0] != 1 || len(gw.OpenedAt) != 1 || gw.OpenedAt[0] != 120 {
		t.Fatalf("window: %+v %v", gw, err)
	}
}
