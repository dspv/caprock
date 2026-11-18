package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// A second session's first ask of a pull request's checks answers at once
// from the pull request the GitHub service already keeps, marked refreshing,
// instead of waiting while its runs are composed (owner, 2026-11-18,
// translated: "I switch to the tab and only after ~10 s the CI data comes").
func TestSessionCIQuickFromKeptPull(t *testing.T) {
	var base string
	var slow atomic.Bool
	release := make(chan struct{})
	inner := ciRoutes(&base)
	s, _, _, _, _, _ := githubServer(t, func(w http.ResponseWriter, r *http.Request) {
		if slow.Load() && r.URL.Path == "/repos/ada/repo/actions/runs" {
			select {
			case <-release:
			case <-r.Context().Done():
			}
		}
		inner(w, r)
	})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	base = s.d.GitHub.API
	s.deck.budget = 50 * time.Millisecond
	for _, id := range []string{"s1", "s2"} {
		if err := store.RecordPR(context.Background(), s.d.Store.DB(), store.PRAction{SessionID: id, URL: "https://github.com/ada/repo/pull/5", Number: 5, Title: "Add x", Action: "created", Ts: 1}); err != nil {
			t.Fatal(err)
		}
	}
	if w := call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`); w.Code != http.StatusOK {
		t.Fatalf("connect: %d %s", w.Code, w.Body.String())
	}
	// s1's pull requests are read: #5 is now kept, its runs never read.
	for until := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		w := call(t, s, machine, "", "GET", "/v1/sessions/s1/prs", "")
		var prs SessionPRs
		_ = json.Unmarshal(w.Body.Bytes(), &prs)
		if w.Code == http.StatusOK && !prs.Refreshing && len(prs.PRs) == 1 && prs.PRs[0].Live != nil {
			break
		}
		if time.Now().After(until) {
			t.Fatalf("s1: %d %s", w.Code, w.Body.String())
		}
	}
	// GitHub is slow to list the runs: s2's first ask of #5's checks still answers within the budget.
	slow.Store(true)
	t0 := time.Now()
	w := call(t, s, machine, "", "GET", "/v1/sessions/s2/ci?pr=5", "")
	took := time.Since(t0)
	var got SessionCI
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if took > 2*time.Second {
		t.Fatalf("s2 waited %s for the composition", took)
	}
	if !got.Refreshing || got.PR == nil || got.PR.Number != 5 || got.PR.Live == nil || got.PR.Live.State != "open" || got.CI != nil {
		t.Fatalf("quick answer: %s", w.Body.String())
	}
	// Its pull requests answer from the same kept read, live state and all.
	if w := call(t, s, machine, "", "GET", "/v1/sessions/s2/prs", ""); w.Code != http.StatusOK {
		t.Fatalf("prs: %d %s", w.Code, w.Body.String())
	} else {
		var prs SessionPRs
		if err := json.Unmarshal(w.Body.Bytes(), &prs); err != nil || len(prs.PRs) != 1 || prs.PRs[0].Live == nil {
			t.Fatalf("prs quick: %s", w.Body.String())
		}
	}
	// Once GitHub answers, the next ask has the runs.
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for {
		w = call(t, s, machine, "", "GET", "/v1/sessions/s2/ci?pr=5", "")
		got = SessionCI{}
		_ = json.Unmarshal(w.Body.Bytes(), &got)
		if got.CI != nil && !got.Refreshing {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never composed: %s", w.Body.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
}
