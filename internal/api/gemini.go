package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/dspv/caprock/internal/gemini"
	"github.com/dspv/caprock/internal/license"
)

// handleGeminiStatus says whether the feature is usable here, without ever
// revealing the key. It answers the two questions the UI has — is there a key,
// and is this a paying user — so the screen can say which one is missing
// instead of showing a dead button.
func (s *Server) handleGeminiStatus(w http.ResponseWriter, r *http.Request) {
	st := license.Parse(s.d.Settings.Get().LicenseKey, s.d.Now())
	writeJSON(w, http.StatusOK, map[string]any{
		"available": gemini.Available(),
		"env_var":   gemini.EnvKey,
		"licensed":  st.Active,
		"model":     gemini.DefaultModel,
	})
}

// handleGeminiAsk sends one prompt to Google on the user's key.
//
// The licence is checked HERE, on the server, which the spend cap deliberately
// does not do. The difference is what the two features cost when the check is
// skipped: a cap spends nothing, while this spends the user's Gemini quota and
// opens an outbound connection. ADR-023 records the reasoning and the limit —
// server-side checks belong to features that spend money or reach the network,
// not to features that draw a panel.
func (s *Server) handleGeminiAsk(w http.ResponseWriter, r *http.Request) {
	if s.d.AskGemini == nil {
		http.Error(w, "gemini not configured", http.StatusNotImplemented)
		return
	}
	if !gemini.Available() {
		// Not an error the user did wrong: the feature is simply not set up.
		writeJSON(w, http.StatusPreconditionFailed, map[string]string{
			"error":  "no api key",
			"detail": "set " + gemini.EnvKey + " in the daemon's environment and restart it",
		})
		return
	}
	if st := license.Parse(s.d.Settings.Get().LicenseKey, s.d.Now()); !st.Active {
		writeJSON(w, http.StatusPaymentRequired, map[string]string{
			"error":  "premium required",
			"detail": "asking Gemini is a paid feature; the key stays yours either way",
		})
		return
	}

	var body struct {
		Prompt string `json:"prompt"`
		Model  string `json:"model"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.Prompt == "" {
		http.Error(w, "empty prompt", http.StatusBadRequest)
		return
	}

	rep, err := s.d.AskGemini(r.Context(), body.Model, body.Prompt)
	if err != nil {
		if errors.Is(err, gemini.ErrNoKey) {
			writeJSON(w, http.StatusPreconditionFailed, map[string]string{"error": "no api key"})
			return
		}
		// Google's own message is more useful than anything we could write.
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, rep)
}
