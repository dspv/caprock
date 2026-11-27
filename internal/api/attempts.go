package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"os"
	"sync"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/gitdiff"
	"github.com/dspv/caprock/internal/store"
)

// One prompt, N attempts (ADR-052): the same agent with the same first
// message in N new copies of one branch, grouped so they can be compared —
// status, changes, cost and time — and the user keeps the one they want.
// Nothing is merged or removed for them.

// attemptsMax is the most attempts one start makes. Each is a worktree, an
// agent and its spend; four is already a lot of all three.
const attemptsMax = 4

// attemptsOf reads `attempts` from a spawn request: 1 when absent, else 2 to
// attemptsMax, and only for a new copy (`worktree`) of a new session. msg is
// why not, for a 400.
func attemptsOf(req map[string]any) (n int, msg string) {
	v, ok := req["attempts"]
	if !ok || v == nil {
		return 1, ""
	}
	f, ok := v.(float64)
	if !ok || f != float64(int(f)) || f < 1 || f > attemptsMax {
		return 0, fmt.Sprintf("attempts is a whole number from 1 to %d", attemptsMax)
	}
	n = int(f)
	if n == 1 {
		return 1, ""
	}
	if name, _ := req["worktree"].(string); name == "" {
		return 0, "attempts need a new copy of a branch (worktree): each attempt gets its own"
	}
	for _, k := range []string{"resume", "relay_from"} {
		if s, _ := req[k].(string); s != "" {
			return 0, "attempts start new sessions; they cannot continue one"
		}
	}
	if chat, _ := req["chat"].(bool); chat {
		return 0, "a quick chat has no copies to make attempts in"
	}
	return n, ""
}

func newAttemptGroup() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// spawnAttempts starts n sessions from one request, one copy each, named
// <worktree>-1 … -n, in order; the first failure stops the rest and is
// reported beside the ones that started. The base is pulled once, for the
// first copy, and the rest start from the commit the first started from, so
// every attempt starts from the same code.
func (s *Server) spawnAttempts(w http.ResponseWriter, r *http.Request, req map[string]any, n int) {
	ctx := context.WithoutCancel(r.Context())
	name, _ := req["worktree"].(string)
	base, _ := req["worktree_base"].(string)
	delete(req, "attempts")
	group := newAttemptGroup()
	var ids []string
	var firstCwd, failed, commit string
	var firstErr error
	for i := 1; i <= n; i++ {
		one := maps.Clone(req)
		one["worktree"] = fmt.Sprintf("%s-%d", name, i)
		if i > 1 && commit != "" {
			// The commit the first copy started from, not the branch again:
			// the branch may have moved, or the first copy came from its
			// remote, and every attempt must start from the same code.
			one["worktree_base"] = commit
			delete(one, "worktree_pull")
			delete(one, "worktree_pr") // the first copy fetched it; the commit is its head
		}
		id, cwd, err := s.d.Agents.Spawn(ctx, one)
		if err != nil {
			failed = fmt.Sprintf("attempt %d of %d did not start: %v", i, n, err)
			firstErr = err
			break
		}
		at := gitdiff.Head(ctx, cwd)
		if i == 1 {
			firstCwd, commit = cwd, at
		}
		ids = append(ids, id)
		a := store.Attempt{SessionID: id, GroupID: group, N: i, Total: n, Base: base, BaseCommit: at, CreatedAt: s.d.Now().UnixMilli()}
		if err := store.InsertAttempt(ctx, s.d.Store.DB(), a); err != nil {
			s.d.Log.Warn("could not record an attempt", "component", "api", "session", id, "err", err)
		}
	}
	if len(ids) == 0 {
		if errors.Is(firstErr, agents.ErrBypassConsent) {
			spawnFail(w, firstErr)
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": failed})
		return
	}
	if len(ids) < n {
		// The group is what started: "attempt 2 of 2", not "of 3" with one missing.
		if err := store.SetAttemptTotal(ctx, s.d.Store.DB(), group, len(ids)); err != nil {
			s.d.Log.Warn("could not correct the attempts' total", "component", "api", "group", group, "err", err)
		}
	}
	if dev := deviceFrom(r); dev != nil {
		s.d.Log.Info("attempts started from a paired device", "component", "api", "group", group, "sessions", ids, "device", dev.ID, "device_name", dev.Name)
	}
	out := map[string]any{"session_id": ids[0], "cwd": firstCwd, "session_ids": ids, "attempt_group": group}
	if failed != "" {
		out["error"] = failed
	}
	writeJSON(w, http.StatusOK, out)
}

// AttemptView is one attempt as the Compare view shows it.
type AttemptView struct {
	store.Attempt
	Session store.Session `json:"session"`
	Stats   store.Stats   `json:"stats"`
	// Changes is what its copy changed since the commit it started from;
	// absent with ChangesError when that could not be read (the folder was
	// removed, git failed).
	Changes      *gitdiff.Totals `json:"changes,omitempty"`
	ChangesError string          `json:"changes_error,omitempty"`
}

// handleAttempts answers GET /v1/attempts/{group}: every attempt of a group,
// with its session, spend and changes.
func (s *Server) handleAttempts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	list, err := store.AttemptGroup(ctx, s.d.Store.DB(), r.PathValue("group"))
	if err != nil {
		s.fail(w, err)
		return
	}
	if len(list) == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such group of attempts"})
		return
	}
	views := make([]AttemptView, len(list))
	var wg sync.WaitGroup
	for i, a := range list {
		views[i].Attempt = a
		sess, err := store.GetSession(ctx, s.d.Store.DB(), a.SessionID)
		if err != nil {
			views[i].Session = store.Session{SessionID: a.SessionID, Status: "ended"}
			views[i].ChangesError = "the session is no longer recorded"
			continue
		}
		views[i].Session = sess
		if st, err := store.GetStats(ctx, s.d.Store.DB(), a.SessionID); err == nil {
			views[i].Stats = st
		}
		wg.Add(1)
		go func(v *AttemptView) {
			defer wg.Done()
			v.Changes, v.ChangesError = attemptChanges(ctx, v.Session.Cwd, v.BaseCommit)
		}(&views[i])
	}
	wg.Wait()
	base := list[0].Base
	writeJSON(w, http.StatusOK, map[string]any{"group": list[0].GroupID, "base": base, "attempts": views})
}

// attemptChanges totals one copy's changes since the commit it started from.
func attemptChanges(ctx context.Context, cwd, base string) (*gitdiff.Totals, string) {
	if cwd == "" {
		return nil, "the session has no folder"
	}
	if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
		return nil, "its copy has been removed"
	}
	t, err := gitdiff.Since(ctx, cwd, base)
	if errors.Is(err, gitdiff.ErrNotARepo) {
		return nil, "its folder is not a git repository"
	}
	if err != nil {
		return nil, err.Error()
	}
	return &t, ""
}
