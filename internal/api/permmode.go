package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/store"
)

// A session's permission mode, shown and changed while it runs (ADR-054;
// contract in 03-contracts.md § Permission mode of a running session).

// PermissionModeView is GET /v1/sessions/{id}/permission-mode.
type PermissionModeView struct {
	SessionID string `json:"session_id"`
	// Mode is Claude Code's word for it ("default", "acceptEdits", "plan",
	// "bypassPermissions", "auto", "dontAsk"); "" when nothing says.
	Mode string `json:"mode"`
	// Source is where Mode was learned: "screen" (the footer, now), "hook"
	// (the session's own hook payload), "switch" (a switch Caprock made and
	// saw take), "launch" (its command line).
	Source string `json:"source,omitempty"`
	// Switchable is a Claude Code session Caprock started and holds the
	// terminal of: Mode can be changed from here. Any other session's mode
	// changes only in its own terminal (rule 7).
	Switchable bool `json:"switchable"`
	// InSession are the modes Shift+Tab reaches in this process; "auto" is
	// in it only when the account has auto mode, which a switch finds out.
	InSession []string `json:"in_session,omitempty"`
	// Restart are the modes only a new process has: the conversation is
	// resumed under its own id with the new flag.
	Restart []string `json:"restart,omitempty"`
	// Waiting says what keeps a switch from happening now: "permission" or
	// "question" (a prompt on the screen) refuse both kinds, "turn" (the
	// agent is working) refuses a restart. "" at the prompt.
	Waiting string `json:"waiting,omitempty"`
}

// ModeError is a switch refused or failed, with the status to answer.
type ModeError struct {
	Status int
	// Code names the refusal for the client: "prompt", "busy", "restart",
	// "bypass_consent", "unreachable", "stuck", "not_owned".
	Code string
	Msg  string
	// Mode is the mode the session was left in, when one was read.
	Mode string
}

func (e *ModeError) Error() string { return e.Msg }

// modeSwitcher is the optional half of AgentController that reads and
// changes an owned session's permission mode. Optional so test doubles need
// not grow it.
type modeSwitcher interface {
	// PermissionMode is an owned session's mode; false when this daemon does
	// not hold it.
	PermissionMode(ctx context.Context, sessionID string) (PermissionModeView, bool)
	// SetPermissionMode switches it by Shift+Tab, or with restart, resumes
	// the conversation in a new process started in mode. Errors are
	// *ModeError where the client can act on them.
	SetPermissionMode(ctx context.Context, sessionID, mode string, restart bool) (PermissionModeView, error)
}

// handlePermissionMode is GET /v1/sessions/{id}/permission-mode.
func (s *Server) handlePermissionMode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if ms, ok := s.d.Agents.(modeSwitcher); ok && s.d.Agents != nil {
		if v, held := ms.PermissionMode(r.Context(), id); held {
			writeJSON(w, http.StatusOK, v)
			return
		}
	}
	// Not Caprock's to change: what its own hooks last said.
	mode, err := store.LastPermissionMode(r.Context(), s.d.Store.DB(), id)
	if err != nil {
		s.fail(w, err)
		return
	}
	v := PermissionModeView{SessionID: id, Mode: agents.CanonicalMode(mode)}
	if v.Mode != "" {
		v.Source = string(agents.SourceHook)
	}
	writeJSON(w, http.StatusOK, v)
}

// handleSetPermissionMode is POST /v1/agents/{id}/permission-mode
// {"mode": "...", "restart": bool}.
func (s *Server) handleSetPermissionMode(w http.ResponseWriter, r *http.Request) {
	if !s.requireAgents(w) {
		return
	}
	ms, ok := s.d.Agents.(modeSwitcher)
	if !ok {
		s.failCode(w, http.StatusNotImplemented, errors.New("this daemon cannot change a session's permission mode"))
		return
	}
	var body struct {
		Mode    string `json:"mode"`
		Restart bool   `json:"restart"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&body); err != nil || agents.CanonicalMode(body.Mode) == "" {
		http.Error(w, `body must be {"mode": "default"|"acceptEdits"|"plan"|"bypassPermissions"|"auto"|"dontAsk", "restart"?: bool}`, http.StatusBadRequest)
		return
	}
	id := r.PathValue("id")
	if body.Restart && deviceFrom(r) != nil {
		s.d.Log.Info("permission-mode restart from a paired device", "component", "api", "session", id, "mode", body.Mode)
	}
	v, err := ms.SetPermissionMode(r.Context(), id, body.Mode, body.Restart)
	if err != nil {
		var me *ModeError
		if errors.As(err, &me) {
			out := map[string]string{"error": me.Msg, "code": me.Code}
			if me.Mode != "" {
				out["mode"] = me.Mode
			}
			writeJSON(w, me.Status, out)
			return
		}
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// restartChecker is the optional half of AgentController that says whether
// a session is being restarted in another mode: its terminals are told to
// reconnect rather than that it ended.
type restartChecker interface {
	Restarting(sessionID string) bool
}

func (s *Server) restarting(id string) bool {
	rc, ok := s.d.Agents.(restartChecker)
	return ok && rc.Restarting(id)
}
