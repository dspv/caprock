package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/gitremote"
	"github.com/dspv/caprock/internal/store"
)

// A composition that fails every time no longer restarts on every poll and
// hides behind "refreshing": the kept answer comes back not refreshing, with
// the failure and its time beside it, and the next composition waits
// deckFailBackoff (owner, 2026-10-14: the board said "updating…" for hours
// over an answer from the afternoon).
func TestAnswerCacheSaysAFailedRefresh(t *testing.T) {
	var clock atomic.Int64
	clock.Store(time.Date(2026, 10, 14, 15, 0, 0, 0, time.UTC).UnixMilli())
	now := func() time.Time { return time.UnixMilli(clock.Load()) }
	s := &Server{deck: newDeckCache(now)}
	c := s.deck
	var calls atomic.Int64
	fail := func() (any, error) { calls.Add(1); return nil, context.DeadlineExceeded }
	if _, _, _, err := c.getAt(context.Background(), "k", func() (any, error) { return "afternoon", nil }); err != nil {
		t.Fatal(err)
	}
	kept := clock.Load()

	clock.Add((deckTTL + time.Second).Milliseconds())
	v, at, refreshing, err := c.getAt(context.Background(), "k", fail)
	c.wait()
	if err != nil || v != "afternoon" || refreshing || at.UnixMilli() != kept {
		t.Fatalf("after a failed refresh: %v at %d refreshing=%v err=%v", v, at.UnixMilli(), refreshing, err)
	}
	f := s.freshOf("k", at, refreshing)
	if f.FetchedAt != kept || f.RefreshError == "" || f.RefreshFailedAt != clock.Load() || f.Refreshing {
		t.Fatalf("freshness: %+v", f)
	}

	// Polled again inside the backoff: no new composition, the failure still said.
	for range 5 {
		clock.Add(time.Second.Milliseconds())
		v, _, refreshing, _ = c.getAt(context.Background(), "k", fail)
		if v != "afternoon" || refreshing {
			t.Fatalf("inside the backoff: %v refreshing=%v", v, refreshing)
		}
	}
	c.wait()
	if n := calls.Load(); n != 1 {
		t.Fatalf("%d compositions inside the backoff, want 1", n)
	}

	// Past it, one more try; when it lands, the failure is gone.
	clock.Add(deckFailBackoff.Milliseconds())
	v, at, refreshing, err = c.getAt(context.Background(), "k", func() (any, error) { return "evening", nil })
	if err != nil || v != "evening" || refreshing {
		t.Fatalf("past the backoff: %v refreshing=%v err=%v", v, refreshing, err)
	}
	if f := s.freshOf("k", at, refreshing); f.RefreshError != "" || f.FetchedAt != clock.Load() {
		t.Fatalf("fresh again: %+v", f)
	}
}

// boardGitHub is a repository with a dozen open pull requests whose own
// reads are slow, as dspv/caprock's were on 2026-10-14 (a pull request, its
// check runs, its status and its reviews: four calls each, half a second
// apiece), and whose list, merges and releases the test moves.
type boardGitHub struct {
	mu       sync.Mutex
	now      func() time.Time
	merged   map[int]time.Time
	releases []string // JSON objects, newest first
	listDown bool
	slow     time.Duration
}

func (g *boardGitHub) route(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer ghp_good" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	w.Header().Set("X-OAuth-Scopes", "repo")
	g.mu.Lock()
	defer g.mu.Unlock()
	ts := func(t time.Time) string { return t.UTC().Format(time.RFC3339) }
	opened := g.now().Add(-6 * time.Hour)
	pull := func(n int) string {
		state, merged := "open", "null"
		if at, ok := g.merged[n]; ok {
			state, merged = "closed", fmt.Sprintf("%q", ts(at))
		}
		return fmt.Sprintf(`{"number":%d,"html_url":"https://github.com/ada/repo/pull/%d","title":"PR %d","state":%q,"created_at":%q,"merged_at":%s,"user":{"login":"ada"},"head":{"ref":"feat/%d","sha":"sha%d"},"base":{"ref":"main"}}`,
			n, n, n, state, ts(opened), merged, n, n)
	}
	switch {
	case r.URL.Path == "/user":
		_, _ = w.Write([]byte(`{"login":"ada"}`))
	case r.URL.Path == "/repos/ada/repo":
		_, _ = w.Write([]byte(`{"default_branch":"main"}`))
	case r.URL.Path == "/repos/ada/repo/pulls":
		if g.listDown {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"message":"Server Error"}`))
			return
		}
		var all []string
		for n := 21; n >= 8; n-- {
			all = append(all, pull(n))
		}
		_, _ = w.Write([]byte("[" + strings.Join(all, ",") + "]"))
	case strings.HasPrefix(r.URL.Path, "/repos/ada/repo/pulls/"):
		var n int
		_, _ = fmt.Sscanf(strings.TrimPrefix(r.URL.Path, "/repos/ada/repo/pulls/"), "%d", &n)
		g.mu.Unlock()
		time.Sleep(g.slow)
		g.mu.Lock()
		if strings.HasSuffix(r.URL.Path, "/reviews") {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		_, _ = w.Write([]byte(pull(n)))
	case strings.HasPrefix(r.URL.Path, "/repos/ada/repo/commits/"):
		g.mu.Unlock()
		time.Sleep(g.slow)
		g.mu.Lock()
		if strings.HasSuffix(r.URL.Path, "/status") {
			_, _ = w.Write([]byte(`{"state":"pending","statuses":[]}`))
			return
		}
		_, _ = w.Write([]byte(`{"total_count":1,"check_runs":[{"id":1,"name":"ci","status":"in_progress","started_at":"` + ts(opened) + `"}]}`))
	case r.URL.Path == "/repos/ada/repo/actions/runs":
		_, _ = w.Write([]byte(`{"workflow_runs":[]}`))
	case r.URL.Path == "/repos/ada/repo/releases":
		_, _ = w.Write([]byte("[" + strings.Join(g.releases, ",") + "]"))
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Not Found"}`))
	}
}

func boardRelease(tag string, at time.Time) string {
	return fmt.Sprintf(`{"tag_name":%q,"name":%q,"html_url":"https://github.com/ada/repo/releases/tag/%s","published_at":%q}`, tag, tag, tag, at.UTC().Format(time.RFC3339))
}

// The board froze on 2026-10-14: a dozen open pull requests with running
// checks were read one after another, which took longer than the
// composition's deadline, so every refresh failed and the board kept its
// afternoon answer — merged pull requests in "CI running", three new
// releases missing — behind "updating…". Now the GitHub reads have their
// own budget: the answer comes in time, the cards not re-read marked stale;
// merges and new releases land on the next refresh; and a list GitHub
// refuses is said, with when it was last read.
func TestBoardFollowsMergesAndReleases(t *testing.T) {
	var clock atomic.Int64
	clock.Store(time.Date(2026, 10, 14, 15, 0, 0, 0, time.UTC).UnixMilli())
	now := func() time.Time { return time.UnixMilli(clock.Load()) }
	g := &boardGitHub{now: now, merged: map[int]time.Time{8: now().Add(-time.Hour)}, slow: 150 * time.Millisecond}
	g.releases = []string{boardRelease("v0.116.0", now().Add(-30*time.Minute))}
	s, _, _, _, _, _ := githubServer(t, g.route)
	s.d.GitHub.Now = now
	s.deck = newDeckCache(now)
	defer func(b time.Duration) { statsGitHubBudget = b }(statsGitHubBudget)
	statsGitHubBudget = 400 * time.Millisecond
	ctx := context.Background()
	if err := store.UpsertSession(ctx, s.d.Store.DB(), "s1", store.SessionPatch{Cwd: "/work/repo", Agent: "claude", StartedAt: 1000, LastEventAt: 2000}); err != nil {
		t.Fatal(err)
	}
	s.repos.lookup = func(_ context.Context, dir string) (gitremote.Repo, bool) {
		return gitremote.Repo{Root: dir, URL: "https://github.com/ada/repo"}, true
	}
	if w := call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`); w.Code != http.StatusOK {
		t.Fatalf("connect: %d %s", w.Code, w.Body.String())
	}
	read := func() SessionCIStats {
		t.Helper()
		start := time.Now()
		w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci/stats", "")
		var got SessionCIStats
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		if took := time.Since(start); took > 5*time.Second {
			t.Fatalf("the answer took %s", took)
		}
		return got
	}
	cards := func(b *PRBoard) map[int]BoardCard {
		m := map[int]BoardCard{}
		for _, c := range b.Cards {
			m[c.Number] = c
		}
		return m
	}

	// Twelve open pull requests at four slow calls each would take seconds:
	// the answer comes within the budget, those not read marked stale.
	first := read()
	// What did not fit is said, not drawn as current.
	if first.Board == nil || first.Error == nil || !strings.Contains(first.Error.Message, "checks") || first.ReadAt != clock.Load() {
		t.Fatalf("first: board=%v error=%v read_at=%d", first.Board != nil, first.Error, first.ReadAt)
	}
	c := cards(first.Board)
	stale := 0
	for n := 10; n <= 21; n++ {
		if c[n].Stage != StageOpen && c[n].Stage != StageReady {
			t.Fatalf("#%d: %+v", n, c[n])
		}
		if c[n].Stale {
			stale++
		}
	}
	if stale == 0 {
		t.Fatalf("no card marked stale, though the reads could not all fit the budget")
	}
	if c[8].Stage != StageReleased || c[8].Release != "v0.116.0" {
		t.Fatalf("#8: %+v", c[8])
	}

	// Three minutes on, #10 and #11 merged and v0.116.1 is published: one
	// refresh moves them to Released and lists the release.
	g.mu.Lock()
	g.merged[10], g.merged[11] = now().Add(time.Minute), now().Add(2*time.Minute)
	g.releases = append([]string{boardRelease("v0.116.1", now().Add(150*time.Second))}, g.releases...)
	g.mu.Unlock()
	clock.Add((3 * time.Minute).Milliseconds())
	_ = read()
	s.deck.wait()
	next := read()
	c = cards(next.Board)
	for _, n := range []int{10, 11} {
		if c[n].Stage != StageReleased || c[n].Release != "v0.116.1" {
			t.Fatalf("#%d after its merge and the release: %+v", n, c[n])
		}
	}
	if len(next.Board.Releases) < 2 || next.Board.Releases[0].Tag != "v0.116.1" {
		t.Fatalf("releases: %+v", next.Board.Releases)
	}
	if next.Refreshing || next.RefreshError != "" || next.ReadAt != clock.Load() {
		t.Fatalf("fresh: refreshing=%v refresh_error=%q read_at=%d", next.Refreshing, next.RefreshError, next.ReadAt)
	}

	// GitHub refuses the list: the board keeps the last one, says why and
	// since when, and is not left refreshing.
	readAt := next.ReadAt
	g.mu.Lock()
	g.listDown = true
	g.mu.Unlock()
	clock.Add((3 * time.Minute).Milliseconds())
	_ = read()
	s.deck.wait()
	down := read()
	if down.Error == nil || down.Error.Status != http.StatusBadGateway || down.ReadAt != readAt || down.Refreshing || down.Board == nil || cards(down.Board)[10].Stage != StageReleased {
		t.Fatalf("list refused: error=%v read_at=%d (want %d) refreshing=%v", down.Error, down.ReadAt, readAt, down.Refreshing)
	}
}
