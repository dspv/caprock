package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/dspv/caprock/internal/gemini"
	"github.com/dspv/caprock/internal/license"
)

// handleGeminiStatus says whether the feature is usable here, without ever
// revealing the key. It answers the two questions the UI has — is there a key,
// and is this a paying user — so the screen can say which one is missing
// instead of showing a dead button.
func (s *Server) handleGeminiStatus(w http.ResponseWriter, r *http.Request) {
	cfg := s.d.Settings.Get()
	st := license.Parse(cfg.LicenseKey, s.d.Now())

	// The choosable models, priced. A twenty-five-fold spread separates the
	// cheapest from the dearest, and it is the reader's money — so the price of
	// a question is shown before it is spent, not after.
	type modelOpt struct {
		ID      string  `json:"id"`
		Display string  `json:"display"`
		Input   float64 `json:"input"`
		Output  float64 `json:"output"`
		// Typical is what a short question costs at this model's rates: roughly
		// 2k in and 500 out, which is what a dashboard question looks like. It
		// is an example, not a promise, and the UI labels it as one.
		Typical float64 `json:"typical_usd"`
	}
	var models []modelOpt
	if s.d.Table != nil {
		for _, m := range s.d.Table.Models {
			if !strings.HasPrefix(m.ID, "gemini-") {
				continue
			}
			models = append(models, modelOpt{
				ID: m.ID, Display: m.Display, Input: m.Input, Output: m.Output,
				Typical: (2000/1e6)*m.Input + (500/1e6)*m.Output,
			})
		}
		sort.Slice(models, func(a, b int) bool { return models[a].Typical < models[b].Typical })
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"available": gemini.Available(cfg.GeminiAPIKey),
		// Which source the key came from, so the panel can explain why editing
		// the field changes nothing when the environment is winning.
		"from_env": gemini.EnvKeyValue() != "",
		"env_var":  gemini.EnvKey,
		"licensed": st.Active,
		"model":    gemini.DefaultModel,
		"models":   models,
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
	if !gemini.Available(s.d.Settings.Get().GeminiAPIKey) {
		// Not an error the user did wrong: the feature is simply not set up.
		writeJSON(w, http.StatusPreconditionFailed, map[string]string{
			"error":  "no Gemini key",
			"detail": "add one on the Cost screen — it works straight away, no restart",
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
