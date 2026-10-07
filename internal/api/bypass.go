package api

import (
	"errors"
	"net/http"
)

// bypassConsentMsg is what a client without the consent screen (an older
// phone page, a script) shows when a bypass start is refused.
const bypassConsentMsg = "Bypass needs a one-time consent first: in Caprock on this computer, start a session in Bypass and accept the warning. Or pick a mode that asks."

// needsBypassConsent reports whether this start would open Claude Code on
// its own bypass warning, whose default answer is "No, exit" (ADR-041): a
// Claude Code session in bypass, on a machine where the warning has not been
// accepted. Another agent, another mode, a command run in a terminal, or a
// daemon that cannot tell, passes.
func (s *Server) needsBypassConsent(req map[string]any) bool {
	if s.d.BypassAccepted == nil {
		return false
	}
	if a, _ := req["agent"].(string); a != "" && a != "claude" {
		return false
	}
	if c, _ := req["command"].(string); c != "" {
		return false
	}
	if m, _ := req["permission_mode"].(string); m != "bypassPermissions" {
		return false
	}
	ok, err := s.d.BypassAccepted()
	// An unreadable settings file is not a reason to refuse: Claude Code
	// would read the same file, and its own warning still stands behind us.
	return err == nil && !ok
}

// handleBypassConsent is POST /v1/claude/bypass-consent: the user accepted
// Caprock's copy of Claude Code's bypass warning, so the same key Claude Code
// writes on "Yes, I accept" is written to user settings. A mutating route:
// the CSRF guard refuses a cross-site request and a paired device cannot make
// it — the consent is given at the machine. Contract: .ai/03-contracts.md.
func (s *Server) handleBypassConsent(w http.ResponseWriter, r *http.Request) {
	if s.d.AcceptBypass == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this daemon cannot record the bypass consent"))
		return
	}
	if err := s.d.AcceptBypass(); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"accepted": true})
}
