package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/gitremote"
	"github.com/dspv/caprock/internal/store"
)

// The Week's pull requests are GitHub's record where github_prs holds one,
// the agents' own count elsewhere; the cost per merged pull request is the
// Pipeline's figure for each; a session started at "/" is a scheduled run
// and counts for nothing (owner, 2026-10-25: the card said 5 PRs in a week
// GitHub merged 59, and 480 of 1,036 sessions were scripts).
func TestWeekCountsPullRequestsFromGitHubsRecord(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	q := e.st.DB()
	repoA, repoB := t.TempDir(), t.TempDir()
	e.api.repos.lookup = func(_ context.Context, dir string) (gitremote.Repo, bool) {
		switch dir {
		case repoA:
			return gitremote.Repo{Root: dir, URL: "https://github.com/ada/repo"}, true
		case repoB:
			return gitremote.Repo{Root: dir, URL: "https://github.com/ada/other"}, true
		}
		return gitremote.Repo{}, false
	}
	for _, s := range []struct{ id, cwd, root string }{{"h1", repoA, repoA}, {"h2", repoB, repoB}, {"sched", "/", ""}} {
		if _, err := q.ExecContext(ctx, `INSERT INTO sessions(session_id, cwd, status, repo_root, agent) VALUES(?,?,?,?,?)`, s.id, s.cwd, "ended", s.root, "claude"); err != nil {
			t.Fatal(err)
		}
	}
	turn := func(sess, key string, cost float64) {
		c := cost
		ev := event.Event{SessionID: sess, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: e.now, Key: key,
			Model: "claude-opus-5", CostUSD: &c, Tokens: &event.TokenDelta{In: 10, Out: 10}}
		if _, err := store.InsertEvent(ctx, q, &ev); err != nil {
			t.Fatal(err)
		}
	}
	turn("h1", "t1", 6)
	turn("h2", "t2", 4)
	turn("sched", "t3", 50)
	post := func(sess, key, cwd, cmd, stdout string) {
		b, _ := json.Marshal(map[string]any{
			"hook_event_name": "PostToolUse", "cwd": cwd,
			"tool_input":    map[string]any{"command": cmd},
			"tool_response": map[string]any{"stdout": stdout, "stderr": "", "interrupted": false},
		})
		ev := event.Event{SessionID: sess, Source: event.SourceHook, Kind: event.KindToolPost, Tool: "Bash", Ts: e.now, Key: key, Payload: b}
		if _, err := store.InsertEvent(ctx, q, &ev); err != nil {
			t.Fatal(err)
		}
	}
	// GitHub's record covers ada/repo, so this one is not counted twice.
	post("h1", "p1", repoA, "gh pr create --fill && gh pr merge --squash", "https://github.com/ada/repo/pull/1")
	// ada/other has no record: the agents' own count stands.
	post("h2", "p2", repoB, "gh pr create --fill", "https://github.com/ada/other/pull/7")
	post("h2", "p3", repoB, "gh pr merge 7 --squash", "")
	// A scheduled run's merge is not hand-run work.
	post("sched", "p4", "/", "gh pr merge https://github.com/ada/third/pull/3", "")

	in := e.now.Add(-60_000_000).UnixMilli() // inside the seven days
	old := e.now.AddDate(0, -2, 0).UnixMilli()
	if err := e.st.UpsertGitHubPRs(ctx, "ada/repo", []store.GitHubPR{
		{Number: 1, URL: "https://github.com/ada/repo/pull/1", State: "merged", CreatedAt: in, MergedAt: in + 1, UpdatedAt: in + 1},
		{Number: 2, URL: "https://github.com/ada/repo/pull/2", State: "merged", CreatedAt: in, MergedAt: in + 2, UpdatedAt: in + 2},
		{Number: 3, URL: "https://github.com/ada/repo/pull/3", State: "open", CreatedAt: in, UpdatedAt: in},
		{Number: 4, URL: "https://github.com/ada/repo/pull/4", State: "merged", CreatedAt: old, MergedAt: old, UpdatedAt: old},
	}, in); err != nil {
		t.Fatal(err)
	}
	// The Pipeline charges h1 to #1: it opened it.
	if _, err := q.ExecContext(ctx, `INSERT OR REPLACE INTO session_stats(session_id, cost_usd) VALUES('h1', 6)`); err != nil {
		t.Fatal(err)
	}
	if _, err := q.ExecContext(ctx, `INSERT INTO session_prs(session_id, url, number, title, opened_at, merged_at, last_at) VALUES('h1','https://github.com/ada/repo/pull/1',1,'PR',?,?,?)`, in, in+1, in+1); err != nil {
		t.Fatal(err)
	}

	var w WeekResponse
	if code := e.get(t, "/v1/week?period=7d", &w); code != 200 {
		t.Fatalf("status %d", code)
	}
	if w.Sessions != 2 || w.ScheduledSessions != 1 || w.CostUSD != 10 {
		t.Fatalf("sessions %d scheduled %d cost %v: the run at / must count for nothing", w.Sessions, w.ScheduledSessions, w.CostUSD)
	}
	// GitHub: #1 and #2 merged, #1-#3 opened; the agents: ada/other#7.
	if w.PRsMerged != 3 || w.PRsOpened != 4 || w.PRsSource != prsFromBoth {
		t.Fatalf("merged %d opened %d source %q", w.PRsMerged, w.PRsOpened, w.PRsSource)
	}
	opened := 0
	for _, d := range w.Days {
		opened += d.PRsOpened
	}
	if opened != 4 {
		t.Fatalf("days carry %d opened, want 4", opened)
	}
	// The Pipeline's figures for #1 ($6) and #2 ($0), over two merges.
	if w.CostPerMergedPR == nil || *w.CostPerMergedPR != 3 {
		t.Fatalf("cost per merged PR %v, want 3", w.CostPerMergedPR)
	}
	for _, a := range w.Agents {
		if a.CostUSD > 10 {
			t.Fatalf("agent row carries the scheduled run: %+v", a)
		}
	}
	b, _ := json.Marshal(w)
	for _, leak := range []string{repoA, repoB, "ada/"} {
		if strings.Contains(string(b), leak) {
			t.Fatalf("the response names %q: %s", leak, b)
		}
	}
}

// With no GitHub record at all, the agents' count is the count, and the cost
// per merged pull request is the window's cost over its merges.
func TestWeekFallsBackToTheAgentsCount(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	q := e.st.DB()
	repo := t.TempDir()
	if _, err := q.ExecContext(ctx, `INSERT INTO sessions(session_id, cwd, status, repo_root, agent) VALUES('h','`+repo+`','ended','`+repo+`','claude')`); err != nil {
		t.Fatal(err)
	}
	c := 8.0
	ev := event.Event{SessionID: "h", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: e.now, Key: "t",
		Model: "claude-opus-5", CostUSD: &c, Tokens: &event.TokenDelta{In: 1, Out: 1}}
	if _, err := store.InsertEvent(ctx, q, &ev); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(map[string]any{"hook_event_name": "PostToolUse", "cwd": repo,
		"tool_input":    map[string]any{"command": "gh pr create --fill && gh pr merge --squash"},
		"tool_response": map[string]any{"stdout": "https://github.com/ada/x/pull/5", "stderr": ""}})
	post := event.Event{SessionID: "h", Source: event.SourceHook, Kind: event.KindToolPost, Tool: "Bash", Ts: e.now, Key: "p", Payload: b}
	if _, err := store.InsertEvent(ctx, q, &post); err != nil {
		t.Fatal(err)
	}
	var w WeekResponse
	if code := e.get(t, "/v1/week?period=7d", &w); code != 200 {
		t.Fatalf("status %d", code)
	}
	if w.PRsMerged != 1 || w.PRsOpened != 1 || w.PRsSource != prsFromAgents {
		t.Fatalf("merged %d opened %d source %q", w.PRsMerged, w.PRsOpened, w.PRsSource)
	}
	if w.CostPerMergedPR == nil || *w.CostPerMergedPR != 8 {
		t.Fatalf("cost per merged PR %v, want 8", w.CostPerMergedPR)
	}
}
