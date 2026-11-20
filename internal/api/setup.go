package api

import (
	"net/http"
	"sort"

	"github.com/dspv/caprock/internal/pairing"
	"github.com/dspv/caprock/internal/readiness"
)

// SetupFacts gathers what GET /v1/setup words (ADR-099): Git on the user's
// PATH as it is now, the agents and their sign-ins, the projects. The daemon
// implements it; the link is read here, from the pairing state the API holds.
type SetupFacts interface {
	SetupFacts(r *http.Request) (readiness.Inputs, error)
}

// handleSetup is GET /v1/setup: this computer's readiness for running agents,
// the checklist of Settings → Computers and `caprock setup`, and what a
// linked laptop reads through /v1/m/{id}/v1/setup. Read only: it names no
// path, token or account — states, sentences and the commands that fix them.
func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	if s.d.Setup == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "the setup checklist is unavailable"})
		return
	}
	in, err := s.d.Setup.SetupFacts(r)
	if err != nil {
		s.fail(w, err)
		return
	}
	in.Link = s.setupLink()
	writeJSON(w, http.StatusOK, readiness.Build(in))
}

// setupLink is the link item's facts: access from anywhere, and the computers
// (devices of kind machine) allowed here or waiting for Allow.
func (s *Server) setupLink() readiness.Link {
	l := readiness.Link{Supported: s.d.Remote != nil}
	if s.d.Remote != nil {
		l.On = s.d.Remote.RemoteState("").Enabled
	}
	ps, _ := s.lanState()
	var devs []pairing.Public
	if ps != nil {
		devs = ps.Devices()
	} else {
		devs = s.devicesOnDisk()
	}
	for _, d := range devs {
		if d.Kind != pairing.KindMachine {
			continue
		}
		if d.Pending {
			l.Waiting = append(l.Waiting, d.Name)
		} else {
			l.Allowed = append(l.Allowed, d.Name)
		}
	}
	sort.Strings(l.Allowed)
	sort.Strings(l.Waiting)
	return l
}
