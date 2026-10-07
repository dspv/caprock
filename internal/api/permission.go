package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/dspv/caprock/internal/agents"
)

// permissioner is the optional half of AgentController that knows the
// permission prompt an owned session is waiting on (ADR-035). Optional so test
// doubles need not grow two methods.
type permissioner interface {
	Permission(sessionID string) (any, bool)
	AnswerPermission(sessionID, promptID, choice string) error
}

// handlePermission is GET /v1/agents/{id}/permission: {"permission": …} with
// the prompt, or null when the session is not waiting on one. Afterwards the
// live socket's "permission" frames carry every change.
func (s *Server) handlePermission(w http.ResponseWriter, r *http.Request) {
	pm, ok := s.d.Agents.(permissioner)
	if s.d.Agents == nil || !ok {
		writeJSON(w, http.StatusOK, map[string]any{"permission": nil})
		return
	}
	p, ok := pm.Permission(r.PathValue("id"))
	if !ok {
		p = nil
	}
	writeJSON(w, http.StatusOK, map[string]any{"permission": p})
}

// handleAnswerPermission is POST /v1/agents/{id}/permission
// {"id": "<prompt id>", "choice": "allow"|"always"|"deny"}: it presses the key
// that answers the prompt, picked from the menu on the session's screen. 409
// when the session is no longer showing that prompt — it was answered in the
// terminal, or it is queued behind another — so a button drawn a moment ago
// cannot answer a question it did not show. 422 when it is, but the menu on
// the screen has no such option or no menu shows; nothing is typed.
func (s *Server) handleAnswerPermission(w http.ResponseWriter, r *http.Request) {
	if !s.requireAgents(w) {
		return
	}
	pm, ok := s.d.Agents.(permissioner)
	if !ok {
		s.failCode(w, http.StatusNotImplemented, errors.New("permission prompts are not supported here"))
		return
	}
	var body struct {
		ID     string `json:"id"`
		Choice string `json:"choice"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&body); err != nil || body.ID == "" {
		http.Error(w, `body must be {"id": "<prompt id>", "choice": "allow"|"always"|"deny"}`, http.StatusBadRequest)
		return
	}
	switch agents.PermissionChoice(body.Choice) {
	case agents.PermissionAllow, agents.PermissionAlways, agents.PermissionDeny:
	default:
		http.Error(w, `choice must be "allow", "always" or "deny"`, http.StatusBadRequest)
		return
	}
	if err := pm.AnswerPermission(r.PathValue("id"), body.ID, body.Choice); err != nil {
		if errors.Is(err, agents.ErrNotOnPrompt) {
			// The prompt still waits, but the menu on the screen has no
			// such option (or no menu is showing): nothing was typed.
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
			return
		}
		s.agentErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
