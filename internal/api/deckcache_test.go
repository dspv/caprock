package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// The deck's cell opens on the last answer it was given: a request that finds
// a kept answer whose GitHub read has expired gets it at once, marked
// refreshing, while one composition — one read of the pull request, whoever
// else asks meanwhile — runs behind it; the next request gets the new one.
func TestDeckPRsAnswerFromWhatIsKept(t *testing.T) {
	var reads atomic.Int64
	var gate atomic.Pointer[chan struct{}]
	route := func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ghp_good" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("X-OAuth-Scopes", "repo")
		switch r.URL.Path {
		case "/user":
			_, _ = w.Write([]byte(`{"login":"ada"}`))
		case "/repos/ada/repo/pulls/5":
			if g := gate.Load(); g != nil {
				<-*g // GitHub is slow: the read waits until the test lets it go
			}
			title := "Add x"
			if reads.Add(1) > 1 {
				title = "Add x, renamed"
			}
			_, _ = w.Write([]byte(`{"number":5,"html_url":"https://github.com/ada/repo/pull/5","title":"` + title + `","state":"open","head":{"ref":"feat/x","sha":"sha5"},"base":{"ref":"main"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
		}
	}
	s, _, _, _, _, _ := githubServer(t, route)
	var clock atomic.Int64
	clock.Store(time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC).UnixMilli())
	now := func() time.Time { return time.UnixMilli(clock.Load()) }
	s.d.GitHub.Now = now
	s.deck = newDeckCache(now)
	if err := store.RecordPR(context.Background(), s.d.Store.DB(), store.PRAction{SessionID: "s1", URL: "https://github.com/ada/repo/pull/5", Number: 5, Title: "Add x", Action: "created", Ts: 1}); err != nil {
		t.Fatal(err)
	}
	if w := call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`); w.Code != http.StatusOK {
		t.Fatalf("connect: %d %s", w.Code, w.Body.String())
	}
	get := func() SessionPRs {
		t.Helper()
		w := call(t, s, machine, "", "GET", "/v1/sessions/s1/prs", "")
		var got SessionPRs
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		return got
	}

	// Never composed: the request waits for it, as before.
	first := get()
	if !first.Connected || len(first.PRs) != 1 || first.PRs[0].Live == nil || first.PRs[0].Live.Title != "Add x" || first.Refreshing {
		t.Fatalf("first: %+v", first)
	}
	if first.FetchedAt != clock.Load() {
		t.Fatalf("fetched_at %d, want the composition's time %d", first.FetchedAt, clock.Load())
	}

	// Inside the TTL nothing is composed again; nothing is asked of GitHub.
	clock.Add(time.Second.Milliseconds())
	if again := get(); again.FetchedAt != first.FetchedAt || reads.Load() != 1 {
		t.Fatalf("inside the TTL: fetched_at %d, %d reads", again.FetchedAt, reads.Load())
	}

	// Ten minutes on, the pull request's kept read has expired and GitHub is
	// slow: every request gets the last answer within the budget, and the
	// pull request is read once.
	g := make(chan struct{})
	gate.Store(&g)
	clock.Add((10 * time.Minute).Milliseconds())
	var wg sync.WaitGroup
	answers := make([]SessionPRs, 5)
	took := make([]time.Duration, 5)
	for i := range answers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			start := time.Now()
			answers[i] = get()
			took[i] = time.Since(start)
		}(i)
	}
	wg.Wait()
	for i, a := range answers {
		if !a.Refreshing || a.FetchedAt != first.FetchedAt || a.PRs[0].Live.Title != "Add x" {
			t.Fatalf("answer %d: %+v", i, a)
		}
		if took[i] > 2*time.Second {
			t.Fatalf("answer %d took %s: it waited on GitHub", i, took[i])
		}
	}
	gate.Store(nil)
	close(g)
	s.deck.wait()
	if n := reads.Load(); n != 2 {
		t.Fatalf("%d reads of the pull request, want 2: the refresh was not shared", n)
	}

	// The refresh landed: the next request has it, stamped with its time.
	fresh := get()
	if fresh.Refreshing || fresh.PRs[0].Live.Title != "Add x, renamed" || fresh.FetchedAt != clock.Load() {
		t.Fatalf("after the refresh: %+v", fresh)
	}
}

// A refresh that lands inside the budget is handed back by the request that
// started it: a deck whose sources answer from what they hold is never one
// poll behind.
func TestAnswerCacheBudgetWaitsForAQuickRefresh(t *testing.T) {
	var clock atomic.Int64
	now := func() time.Time { return time.UnixMilli(clock.Load()) }
	c := newDeckCache(now)
	var n atomic.Int64
	quick := func() (any, error) { return n.Add(1), nil }
	if _, _, _, err := c.getAt(context.Background(), "k", quick); err != nil {
		t.Fatal(err)
	}
	clock.Add((deckTTL + time.Second).Milliseconds())
	v, at, refreshing, err := c.getAt(context.Background(), "k", quick)
	if err != nil || v != int64(2) || refreshing || at.UnixMilli() != clock.Load() {
		t.Fatalf("got %v at %d refreshing=%v err=%v, want the fresh answer", v, at.UnixMilli(), refreshing, err)
	}

	// A refresh that fails keeps the answer before it.
	clock.Add((deckTTL + time.Second).Milliseconds())
	v, _, refreshing, err = c.getAt(context.Background(), "k", func() (any, error) { return nil, context.DeadlineExceeded })
	if err != nil || v != int64(2) || refreshing {
		t.Fatalf("after a failed refresh: %v refreshing=%v err=%v", v, refreshing, err)
	}
}

// The kept keys are bounded: past maxKeys the oldest answer goes.
func TestAnswerCacheBoundsItsKeys(t *testing.T) {
	var clock atomic.Int64
	c := newDeckCache(func() time.Time { return time.UnixMilli(clock.Load()) })
	c.maxKeys = 3
	for _, k := range []string{"a", "b", "c", "d"} {
		clock.Add(1000)
		if _, err := c.get(context.Background(), k, func() (any, error) { return k, nil }); err != nil {
			t.Fatal(err)
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.m["a"]; ok || len(c.m) != 3 {
		t.Fatalf("kept %d keys, the oldest still there: %v", len(c.m), ok)
	}
}
