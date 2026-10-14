package mail

import (
	"encoding/json"
	"errors"
	"net/http"
)

// setSample is POST /v1/mail/sample {on}: try Mail on sample accounts, or
// leave them. It answers with the new state of the switch.
func (s *Service) setSample(w http.ResponseWriter, r *http.Request) {
	var req struct {
		On bool `json:"on"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	if err := s.SetSample(req.On); err != nil {
		code := 500
		if errors.Is(err, errDemoForced) {
			code = 409
		}
		fail(w, code, err)
		return
	}
	writeJSON(w, map[string]bool{"sample": s.inSample()})
}
