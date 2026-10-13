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
//
// GitHub is asked no more than before: a composition calls the same kept
// reads as the request used to, each still deciding by its own freshness
// whether to ask, and a burst of requests for one key composes once.
// Whether GitHub is connected is part of the key, so connecting is not
// answered with the "not connected" answer kept from before.
package api

import (
	"context"
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
)

func newDeckCache(now func() time.Time) *answerCache {
	c := newAnswerCache(deckTTL, deckMaxStale, now)
	c.budget = deckBudget
	c.maxKeys = deckMaxKeys
	return c
}

// deckAnswer is a composed answer that can say when it was composed and
// whether a newer one is being composed.
type deckAnswer interface {
	stamped(fetchedAt int64, refreshing bool) any
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
	base := context.WithoutCancel(r.Context())
	v, at, refreshing, err := s.deck.getAt(r.Context(), key, func() (any, error) {
		ctx, cancel := context.WithTimeout(base, deckComposeTimeout)
		defer cancel()
		return compose(ctx)
	})
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v.(deckAnswer).stamped(at.UnixMilli(), refreshing))
}

// githubConnected says whether GitHub is connected now.
func (s *Server) githubConnected() bool {
	return s.d.GitHub != nil && s.d.GitHub.Status().Connected
}
