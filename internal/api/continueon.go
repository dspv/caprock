package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"

	"github.com/dspv/caprock/internal/subs"
)

// Continue a session on another provider or sign-in (ADR-090): what the
// limit strip's buttons and the automatic move call. The daemon does the
// work (daemon/continueon.go); this is the contract.

// ContinueOnResult is what POST /v1/sessions/{id}/continue-on answers, and
// what the "continued" live frame carries.
type ContinueOnResult struct {
	// SessionID is the session now carrying the work: the tab to show in
	// place of ContinuedFrom's.
	SessionID string `json:"session_id"`
	Cwd       string `json:"cwd"`
	// ContinuedFrom is the session it continues (also its parent_session,
	// or its relay_from for a summary).
	ContinuedFrom string `json:"continued_from"`
	// Target is what it runs on now: a subscription id, "default",
	// "deepseek", "kimi" or "codex".
	Target string `json:"target"`
	// From is what ContinuedFrom ran on, in the same terms: the target that
	// undoes this move.
	From string `json:"from"`
	// How it was carried: "resume" (the same conversation, resumed from its
	// transcript in the same configuration directory), "copy" (the same
	// conversation, its transcript copied into the other sign-in's
	// directory first) or "summary" (a new Codex session given a brief of
	// the work — not the conversation).
	How string `json:"how"`
	// SameConversation is true for "resume" and "copy".
	SameConversation bool `json:"same_conversation"`
	// StoppedOriginal says Caprock ended ContinuedFrom's process.
	StoppedOriginal bool `json:"stopped_original"`
	// Auto marks a move Caprock made by itself (limit_action "auto").
	Auto bool `json:"auto,omitempty"`
	// ReturnAt is when an automatic move goes back to From (unix ms):
	// limit_return_after_reset is on and the limit's reset is known.
	ReturnAt int64 `json:"return_at,omitempty"`
	// Note says, in plain words, what the user has now.
	Note string `json:"note"`
}

// Errors a SessionContinuer returns, mapped to statuses by the handler.
var (
	// ErrContinueNotOwned: Caprock did not start the session (rule 7).
	ErrContinueNotOwned = errors.New("this session was not started by Caprock, so Caprock cannot stop it to continue it elsewhere; continue it from its own terminal")
	// ErrContinueNotFound: no such session.
	ErrContinueNotFound = errors.New("no such session")
)

// ContinueRefusal is a request that cannot be carried out as asked, with
// the reason to show (400).
type ContinueRefusal struct{ Msg string }

func (e ContinueRefusal) Error() string { return e.Msg }

// SessionContinuer is the daemon side of continue-on, implemented by the
// agent controller.
type SessionContinuer interface {
	ContinueOn(ctx context.Context, id, target string) (ContinueOnResult, error)
}

// handleContinueOn is POST /v1/sessions/{id}/continue-on {target}. On the
// machine only: it stops a process and starts another on another account,
// which is the machine's owner's to do (not in controllerRoutes, and
// refused here for any paired device besides).
func (s *Server) handleContinueOn(w http.ResponseWriter, r *http.Request) {
	if deviceFrom(r) != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "a session is moved to another account on the machine Caprock runs on"})
		return
	}
	c, ok := s.d.Agents.(SessionContinuer)
	if s.d.Agents == nil || !ok {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "continuing a session elsewhere is unavailable"})
		return
	}
	var body struct {
		Target string `json:"target"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil || body.Target == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `say where: {"target": "<subscription id>" | "default" | "deepseek" | "kimi" | "codex"}`})
		return
	}
	res, err := c.ContinueOn(r.Context(), r.PathValue("id"), body.Target)
	var refusal ContinueRefusal
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, res)
	case errors.Is(err, ErrContinueNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrContinueNotOwned):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.As(err, &refusal):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": refusal.Msg})
	default:
		s.fail(w, err)
	}
}

// LimitTargets are the fixed targets limit_fallbacks may name besides an
// added sign-in's id.
var LimitTargets = []string{subs.DefaultID, subs.DeepSeekID, subs.KimiID, "codex"}

// maxLimitFallbacks bounds the list; there are not this many accounts.
const maxLimitFallbacks = 16

// cleanLimitFallbacks holds limit_fallbacks to ids that could name a
// target: the fixed ones and well-formed subscription ids, each once, in
// the order given. Whether one is available is decided when it is used.
func cleanLimitFallbacks(in []string) ([]string, error) {
	out := []string{}
	for _, id := range in {
		if !slices.Contains(LimitTargets, id) && !subs.ValidID(id) {
			return nil, fmt.Errorf("limit_fallbacks: %q is not a subscription id, %q, %q, %q or %q", id, subs.DefaultID, subs.DeepSeekID, subs.KimiID, "codex")
		}
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	if len(out) > maxLimitFallbacks {
		return nil, fmt.Errorf("limit_fallbacks: at most %d", maxLimitFallbacks)
	}
	return out, nil
}
