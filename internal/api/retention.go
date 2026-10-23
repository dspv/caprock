package api

import (
	"errors"
	"net/http"
)

// RetentionOfferBelow is the period at or under which the Lifetime screen
// offers to keep transcripts: Claude Code's default is 30 days, and a user
// who chose more than three months has made a choice of their own.
const RetentionOfferBelow = 90

// Retention is GET /v1/claude/retention: how long Claude Code keeps a
// transcript before deleting it (cleanupPeriodDays in user settings).
type Retention struct {
	// Days is the period Claude Code applies: the setting, or its default.
	Days int `json:"days"`
	// Set reports whether user settings name a period.
	Set bool `json:"set"`
	// Offer is whether the Lifetime screen offers to keep them: unset, or
	// RetentionOfferBelow days or fewer.
	Offer bool `json:"offer"`
	// KeepDays is what POST writes.
	KeepDays int `json:"keep_days"`
	// Error is why the settings file could not be read (it is not valid
	// JSON, say). Claude Code skips such a file and applies its default,
	// so the period is the default; POST refuses until it is fixed.
	Error string `json:"error,omitempty"`
}

// handleRetention is GET /v1/claude/retention. Read from the user's own
// settings file on this machine; nothing leaves it.
func (s *Server) handleRetention(w http.ResponseWriter, r *http.Request) {
	if s.d.ReadRetention == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this daemon does not read Claude Code's settings"))
		return
	}
	writeJSON(w, http.StatusOK, s.retention())
}

func (s *Server) retention() Retention {
	days, set, err := s.d.ReadRetention()
	out := Retention{Days: days, Set: set, KeepDays: s.keepDays()}
	if err != nil {
		out.Error = err.Error()
	}
	out.Offer = !set || days <= RetentionOfferBelow
	return out
}

func (s *Server) keepDays() int {
	if s.d.KeepTranscriptDays > 0 {
		return s.d.KeepTranscriptDays
	}
	return 36500
}

// handleKeepTranscripts is POST /v1/claude/retention: the user pressed
// "Keep them from now on", so cleanupPeriodDays is written into user
// settings — the one key, every other key and byte of the file kept, the
// file backed up once and written atomically (hooks.KeepTranscripts). An
// unparsable file is refused with 409 and left as it is. A mutating route:
// cross-site requests and paired devices are refused, so it is asked for at
// the machine. Contract: .ai/03-contracts.md.
func (s *Server) handleKeepTranscripts(w http.ResponseWriter, r *http.Request) {
	if s.d.KeepTranscripts == nil || s.d.ReadRetention == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this daemon does not write Claude Code's settings"))
		return
	}
	if err := s.d.KeepTranscripts(s.keepDays()); err != nil {
		s.failCode(w, http.StatusConflict, err)
		return
	}
	writeJSON(w, http.StatusOK, s.retention())
}
