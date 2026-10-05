package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// RemoveRequest is the body of POST /v1/sessions/remove: the sessions to
// remove, named by id or by the folder they ran in. DryRun lists them and
// changes nothing.
type RemoveRequest struct {
	IDs       []string `json:"ids"`
	CwdPrefix string   `json:"cwd_prefix"`
	DryRun    bool     `json:"dry_run"`
}

// RemoveSkipped is a matched session that was left alone, and why.
type RemoveSkipped struct {
	store.RemovalCandidate
	Reason string `json:"reason"`
}

// RemoveResult is what POST /v1/sessions/remove did, or would do.
type RemoveResult struct {
	DryRun   bool                     `json:"dry_run"`
	Sessions []store.RemovalCandidate `json:"sessions"`
	Skipped  []RemoveSkipped          `json:"skipped"`
	CostUSD  float64                  `json:"cost_usd"`
	// UnmatchedUSD is cost that could not be found in any day's totals to
	// take out (store.RemoveSession); zero in every case seen so far.
	UnmatchedUSD float64 `json:"unmatched_usd"`
}

// removeMaxIDs bounds one request; the CLI's folder match is the bulk path.
const removeMaxIDs = 500

// handleRemoveSessions is POST /v1/sessions/remove (ADR-037). The machine
// only: no paired device reaches it, whatever its role (lanauth.go lists
// neither this route nor anything like it), and the handler refuses one again
// in case the gate ever changes.
//
// A session still running is skipped rather than removed: one Caprock holds a
// terminal for, or one whose agent is active. Removing it would hide work in
// progress, and every event it went on to send would be dropped.
func (s *Server) handleRemoveSessions(w http.ResponseWriter, r *http.Request) {
	if s.fromPairedDevice(r) {
		s.failCode(w, http.StatusForbidden, errors.New("sessions are removed on the machine Caprock runs on"))
		return
	}
	var req RemoveRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body must be {"ids": [...]} or {"cwd_prefix": "..."}, with "dry_run" to only list them`})
		return
	}
	if len(req.IDs) > removeMaxIDs {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too many ids in one request"})
		return
	}
	ctx := r.Context()
	found, err := store.FindRemovalCandidates(ctx, s.d.Store.DB(), req.IDs, req.CwdPrefix)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	res := RemoveResult{DryRun: req.DryRun, Sessions: []store.RemovalCandidate{}, Skipped: []RemoveSkipped{}}
	for _, c := range found {
		if reason := s.stillRunning(c); reason != "" {
			res.Skipped = append(res.Skipped, RemoveSkipped{RemovalCandidate: c, Reason: reason})
			continue
		}
		res.Sessions = append(res.Sessions, c)
		res.CostUSD += c.CostUSD
	}
	if req.DryRun || len(res.Sessions) == 0 {
		writeJSON(w, http.StatusOK, res)
		return
	}
	now := s.d.Now().UnixMilli()
	err = s.d.Store.WithTx(ctx, func(q store.Querier) error {
		for _, c := range res.Sessions {
			missed, err := store.RemoveSession(ctx, q, c, time.Local, now)
			if err != nil {
				return err
			}
			res.UnmatchedUSD += missed
		}
		return nil
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	s.d.Log.Info("sessions removed from Caprock", "component", "api", "count", len(res.Sessions),
		"cost_usd", res.CostUSD, "unmatched_usd", res.UnmatchedUSD)
	s.forgetAnswers()
	writeJSON(w, http.StatusOK, res)
}

// stillRunning names why a session may not be removed now, or "".
func (s *Server) stillRunning(c store.RemovalCandidate) string {
	if s.d.Agents != nil && s.d.Agents.Holds(c.SessionID) {
		return "Caprock is running it — stop it first"
	}
	if c.Status == store.StatusActive {
		return "it is still active — remove it once it has ended"
	}
	return ""
}

// forgetAnswers drops every cached aggregate, so the totals reflect a removal
// on the next read instead of up to one refresh later.
func (s *Server) forgetAnswers() {
	for _, c := range []*answerCache{s.hist, s.summ, s.week, s.weekLong, s.glance, s.drill} {
		c.forget()
	}
}
