package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/gitremote"
	"github.com/dspv/caprock/internal/store"
)

// A repository whose record does not reach the period's start is read from
// GitHub once, in the background, and the next count is GitHub's whole one
// (owner, 2026-10-25: the card said 48 merged in a week GitHub merged 59).
// Once the period is covered, only what changed is read, at most every
// prsTopUpEvery; GitHub not connected, nothing is asked.
func TestWeekReadsTheMissingPullRequestsFromGitHubOnce(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	q := e.st.DB()
	repo := t.TempDir()
	e.api.repos.lookup = func(_ context.Context, dir string) (gitremote.Repo, bool) {
		if dir == repo {
			return gitremote.Repo{Root: dir, URL: "https://github.com/ada/repo"}, true
		}
		return gitremote.Repo{}, false
	}
	var clockMu sync.Mutex
	now := e.now.Add(30 * time.Second)
	e.api.d.Now = func() time.Time { clockMu.Lock(); defer clockMu.Unlock(); return now }
	if _, err := q.ExecContext(ctx, `INSERT INTO sessions(session_id, cwd, status, repo_root, agent) VALUES('h',?,'ended',?,'claude')`, repo, repo); err != nil {
		t.Fatal(err)
	}
	c := 12.0
	ev := event.Event{SessionID: "h", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: e.now, Key: "t",
		Model: "claude-opus-5", CostUSD: &c, Tokens: &event.TokenDelta{In: 1, Out: 1}}
	if _, err := store.InsertEvent(ctx, q, &ev); err != nil {
		t.Fatal(err)
	}
	day := func(n int) time.Time { return e.now.Add(-time.Duration(n) * 24 * time.Hour) }
	// The Pipeline's newest-50 record began yesterday: it has #12 only.
	if err := e.st.UpsertGitHubPRs(ctx, "ada/repo", []store.GitHubPR{
		{Number: 12, URL: "https://github.com/ada/repo/pull/12", State: "merged", CreatedAt: day(1).UnixMilli(), MergedAt: day(1).UnixMilli(), UpdatedAt: day(1).UnixMilli()},
	}, day(1).UnixMilli()); err != nil {
		t.Fatal(err)
	}

	pull := func(n int, at time.Time, merged, fork bool) map[string]any {
		s := at.UTC().Format(time.RFC3339)
		full := "ada/repo"
		if fork {
			full = "grace/repo"
		}
		p := map[string]any{"number": n, "html_url": "https://github.com/ada/repo/pull/" + strconv.Itoa(n), "title": "t",
			"state": "closed", "created_at": s, "updated_at": s,
			"head": map[string]any{"ref": "feat/" + strconv.Itoa(n), "sha": "x", "repo": map[string]any{"full_name": full}},
			"base": map[string]any{"ref": "main"}}
		if merged {
			p["merged_at"] = s
		} else {
			p["state"] = "open"
		}
		return p
	}
	var mu sync.Mutex
	var asked []string
	count := func() int { mu.Lock(); defer mu.Unlock(); return len(asked) }
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ghp_good" || r.URL.Path != "/repos/ada/repo/pulls" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		mu.Lock()
		asked = append(asked, r.URL.RawQuery)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]any{
			pull(12, day(1), true, false),
			pull(11, day(3), true, true), // a fork's: GitHub counts it, so does the card
			pull(10, day(4), false, false),
			pull(9, day(5), true, false),
			pull(8, day(20), true, false), // before the week
		})
	}))
	t.Cleanup(fake.Close)
	cfg := &ghConfig{}
	e.api.d.GitHub = &github.Service{API: fake.URL, Web: fake.URL, HTTP: fake.Client(), Store: &ghStore{tok: "ghp_good"}, Config: cfg}

	week := func(period string) WeekResponse {
		t.Helper()
		var w WeekResponse
		if code := e.get(t, "/v1/week?period="+period, &w); code != 200 {
			t.Fatalf("status %d", code)
		}
		e.api.prsFill.wg.Wait()
		return w
	}
	// Not connected: the record as it is, nothing asked.
	if w := week("7d"); w.PRsMerged != 1 || count() != 0 {
		t.Fatalf("not connected: merged %d, %d asked", w.PRsMerged, count())
	}
	_ = cfg.SetSource(github.SourceToken)
	// The first answer is the one kept so far, from the cache even (no event
	// was written since); it starts the read.
	if w := week("7d"); w.PRsMerged != 1 {
		t.Fatalf("first count %d", w.PRsMerged)
	}
	if count() != 1 || !strings.Contains(asked[0], "sort=updated") || !strings.Contains(asked[0], "page=1") {
		t.Fatalf("asked %v", asked)
	}
	// The next is GitHub's whole week: #12, #11 and #9 merged, #9-#12 opened.
	w := week("7d")
	if w.PRsMerged != 3 || w.PRsOpened != 4 || w.PRsSource != prsFromGitHub {
		t.Fatalf("after the read: merged %d opened %d source %q", w.PRsMerged, w.PRsOpened, w.PRsSource)
	}
	if count() != 1 {
		t.Fatalf("the period is covered, yet asked again: %v", asked)
	}
	v, _ := e.st.GetMeta(ctx, prsReadKey+"ada/repo")
	read, ok := parsePRsRead(v)
	if !ok || read.from != w.FromMs || read.at != now.UnixMilli() {
		t.Fatalf("meta %q, want from %d", v, w.FromMs)
	}
	var head string
	if err := q.QueryRowContext(ctx, `SELECT head FROM github_prs WHERE repo = 'ada/repo' AND number = 11`).Scan(&head); err != nil || head != "" {
		t.Fatalf("the fork's pull request head %q %v", head, err)
	}
	// Past prsTopUpEvery, what changed since the last read is asked for.
	clockMu.Lock()
	now = now.Add(prsTopUpEvery)
	clockMu.Unlock()
	week("7d")
	if count() != 2 {
		t.Fatalf("top-up: asked %v", asked)
	}
	// An earlier start reads back to it.
	m := week("30d")
	if count() != 3 {
		t.Fatalf("30d: asked %v", asked)
	}
	v, _ = e.st.GetMeta(ctx, prsReadKey+"ada/repo")
	if read, _ = parsePRsRead(v); read.from != m.FromMs {
		t.Fatalf("meta after 30d %q, want from %d", v, m.FromMs)
	}
}
