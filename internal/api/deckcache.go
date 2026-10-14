// The session deck's Pull requests & CI cell answers from what the daemon
// last put together for it.
//
// Each of its views (GET /v1/sessions/{id}/prs, …/ci, …/ci/release,
// …/ci/main, …/branches) is composed from reads the GitHub service keeps
// (github.PullByURL, CIBySHA, ReleaseByRepo, MainCI, PullsByBranch), each
// with its own freshness. While those hold, composing is milliseconds; once
// one has expired, composing waits on GitHub — four pull requests read one
// after the other, three calls each, so seconds — and the deck, which is
// unmounted while closed, opened on an empty cell for that long (owner,
// 2026-10-13, translated: "for a while nothing is shown, it looks frozen and
// empty").
//
// So the composed answer is kept per session, view and pull request
// (deckCache), and asked through answerCache:
//
//   - A request for a key never composed waits for it, as before, and
//     concurrent ones share the one composition.
//   - Past deckTTL a request starts one background composition and waits up
//     to deckBudget for it: when the sources answer from what they hold, the
//     reader gets the fresh answer; when one has to ask GitHub, the reader
//     gets the last answer at once, marked `refreshing`, and the next poll
//     finds the new one.
//   - Every answer says when it was composed (`fetched_at`, Unix ms), so the
//     deck can say how fresh what it shows is.
//   - A background composition that fails leaves the last answer in place
//     and says so: `refresh_error` and `refresh_failed_at` ride on that
//     answer, and the next composition waits deckFailBackoff. Before, a
//     composition that failed every time (GitHub slower than its deadline)
//     restarted on every poll and the reader saw the old answer marked
//     `refreshing` for as long as it was kept — a bare "updating…" over a
//     board frozen for hours (owner, 2026-10-14).
//
// GitHub is asked no more than before: a composition calls the same kept
// reads as the request used to, each still deciding by its own freshness
// whether to ask, and a burst of requests for one key composes once.
// Whether GitHub is connected is part of the key, so connecting is not
// answered with the "not connected" answer kept from before.
package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"
)

const (
	// deckTTL is how long a composed answer is handed back as it is: a burst
	// (two clients, a remount) composes once.
	deckTTL = 2 * time.Second
	// deckBudget is how long a request holding a stale answer waits for the
	// composition it started before taking the stale one.
	deckBudget = 300 * time.Millisecond
	// deckMaxStale bounds what is shown while it refreshes: older than this,
	// the request waits for a fresh answer.
	deckMaxStale = time.Hour
	// deckMaxKeys bounds the sessions × views kept.
	deckMaxKeys = 256
	// deckComposeTimeout bounds one composition, as the request's own
	// timeout used to.
	deckComposeTimeout = 15 * time.Second
	// deckFailBackoff is how long after a failed background composition the
	// kept answer is handed back, its failure said, before another starts.
	deckFailBackoff = 20 * time.Second
)

func newDeckCache(now func() time.Time) *answerCache {
	c := newAnswerCache(deckTTL, deckMaxStale, now)
	c.budget = deckBudget
	c.maxKeys = deckMaxKeys
	c.failBackoff = deckFailBackoff
	return c
}

// deckFresh is how fresh a deck answer is; every view's answer carries it
// inline.
type deckFresh struct {
	// FetchedAt is when the answer was composed (Unix ms).
	FetchedAt int64 `json:"fetched_at"`
	// Refreshing says a newer answer is being composed: ask again soon.
	Refreshing bool `json:"refreshing,omitempty"`
	// RefreshError is why the newest composition failed, at
	// RefreshFailedAt (Unix ms): the answer is the one before it.
	RefreshError    string `json:"refresh_error,omitempty"`
	RefreshFailedAt int64  `json:"refresh_failed_at,omitempty"`
}

// deckAnswer is a composed answer that can say how fresh it is.
type deckAnswer interface {
	stamped(f deckFresh) any
}

// freshOf is the freshness of the answer composed at at for key: with the
// failure of a newer composition, if one failed since.
func (s *Server) freshOf(key string, at time.Time, refreshing bool) deckFresh {
	f := deckFresh{FetchedAt: at.UnixMilli(), Refreshing: refreshing}
	if failAt, err := s.deck.failure(key); err != nil && failAt.After(at) {
		f.RefreshError, f.RefreshFailedAt = refreshWords(err), failAt.UnixMilli()
	}
	return f
}

// refreshWords is a failed composition's error as the header says it.
func refreshWords(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "GitHub or the database did not answer in time"
	}
	return err.Error()
}

// deckKey is a deck answer's key: the view, the session, whether GitHub is
// connected, and the pull request asked for (0 when none).
func deckKey(view, session string, connected bool, pr int) string {
	c := "0"
	if connected {
		c = "1"
	}
	return view + "|" + session + "|" + c + "|" + strconv.Itoa(pr)
}

// serveDeck writes the deck answer for key, composing it with compose on a
// context of its own when there is none to hand back (see the file comment).
// fail writes an error compose returned; errors are not kept.
func (s *Server) serveDeck(w http.ResponseWriter, r *http.Request, key string, compose func(ctx context.Context) (deckAnswer, error), fail func(http.ResponseWriter, error)) {
	s.serveDeckWithin(w, r, key, deckComposeTimeout, compose, fail)
}

// serveDeckWithin is serveDeck with a composition bounded by within instead
// of deckComposeTimeout.
func (s *Server) serveDeckWithin(w http.ResponseWriter, r *http.Request, key string, within time.Duration, compose func(ctx context.Context) (deckAnswer, error), fail func(http.ResponseWriter, error)) {
	base := context.WithoutCancel(r.Context())
	v, at, refreshing, err := s.deck.getAt(r.Context(), key, func() (any, error) {
		ctx, cancel := context.WithTimeout(base, within)
		defer cancel()
		return compose(ctx)
	})
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v.(deckAnswer).stamped(s.freshOf(key, at, refreshing)))
}

// serveDeckOrQuick is serveDeck for a view that has a quick answer of its
// own: when the composition takes longer than deckBudget — a key never
// composed, whose sources have to ask GitHub — the request gets quick's
// answer at once, marked `refreshing`, and the composition goes on in the
// background so the next poll (the deck asks again after 1.5 s while an
// answer says refreshing) finds it. The PRs view's quick answer is the
// session's pull requests as the daemon recorded them, without GitHub's
// live state: the rows are drawn at once and their CI fills in (owner,
// 2026-10-13, translated: "PRs take long to load").
func (s *Server) serveDeckOrQuick(w http.ResponseWriter, r *http.Request, key string, compose func(ctx context.Context) (deckAnswer, error), quick func(ctx context.Context) (deckAnswer, error), fail func(http.ResponseWriter, error)) {
	s.serveDeckOrQuickWithin(w, r, key, deckComposeTimeout, compose, quick, fail)
}

// serveDeckOrQuickWithin is serveDeckOrQuick with a composition bounded by
// within instead of deckComposeTimeout.
func (s *Server) serveDeckOrQuickWithin(w http.ResponseWriter, r *http.Request, key string, within time.Duration, compose func(ctx context.Context) (deckAnswer, error), quick func(ctx context.Context) (deckAnswer, error), fail func(http.ResponseWriter, error)) {
	if s.deck.kept(key) {
		// The last answer comes within the budget anyway, live state and all.
		s.serveDeckWithin(w, r, key, within, compose, fail)
		return
	}
	base := context.WithoutCancel(r.Context())
	type result struct {
		v          any
		at         time.Time
		refreshing bool
		err        error
	}
	ch := make(chan result, 1)
	go func() {
		v, at, refreshing, err := s.deck.getAt(base, key, func() (any, error) {
			ctx, cancel := context.WithTimeout(base, within)
			defer cancel()
			return compose(ctx)
		})
		ch <- result{v, at, refreshing, err}
	}()
	t := time.NewTimer(s.deck.budget)
	defer t.Stop()
	select {
	case x := <-ch:
		if x.err != nil {
			fail(w, x.err)
			return
		}
		writeJSON(w, http.StatusOK, x.v.(deckAnswer).stamped(s.freshOf(key, x.at, x.refreshing)))
	case <-t.C:
		q, err := quick(r.Context())
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, q.stamped(deckFresh{FetchedAt: s.deck.now().UnixMilli(), Refreshing: true}))
	case <-r.Context().Done():
	}
}

// githubConnected says whether GitHub is connected now.
func (s *Server) githubConnected() bool {
	return s.d.GitHub != nil && s.d.GitHub.Status().Connected
}
