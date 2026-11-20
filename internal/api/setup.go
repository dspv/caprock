package api

import (
	"net/http"
	"path/filepath"
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
// token or account — states, sentences and the commands that fix them. Two
// folders are named, because the step cannot be done without them (owner,
// 2026-11-20): where a clone goes, and a folder an agent is in that a
// terminal's PATH lacks. A linked laptop is the owner's own, already trusted
// with full scope here (ADR-067).
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
	in.CloneDir = s.cloneDir()
	writeJSON(w, http.StatusOK, readiness.Build(in))
}

// SetupSwitch keeps an agent's switch in the checklist (ADR-099 amendment).
// The daemon's setupAdapter implements it beside SetupFacts.
type SetupSwitch interface {
	SetAgentSwitch(id string, on bool) error
}

// handleSetupAgent is PUT /v1/setup/agents/{id} {"on": bool}: an agent's
// switch in the checklist, kept in this computer's settings, so the laptop
// reading its readiness and `caprock setup` see the same. Only an agent the
// checklist lists; nothing is installed or removed. This computer's own
// clients only: a linked laptop reads readiness and changes nothing here.
// Answers the checklist as it now reads.
func (s *Server) handleSetupAgent(w http.ResponseWriter, r *http.Request) {
	sw, ok := s.d.Setup.(SetupSwitch)
	if s.d.Setup == nil || !ok {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "the setup checklist is unavailable"})
		return
	}
	var body struct {
		On *bool `json:"on"`
	}
	if !decodeLimited(w, r, 1<<10, &body, `{"on": true|false}`) {
		return
	}
	if body.On == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body is {"on": true|false}`})
		return
	}
	id := r.PathValue("id")
	in, err := s.d.Setup.SetupFacts(r)
	if err != nil {
		s.fail(w, err)
		return
	}
	known := false
	for _, a := range in.Agents {
		known = known || a.ID == id
	}
	if !known {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such agent in the checklist: " + id})
		return
	}
	if err := sw.SetAgentSwitch(id, *body.On); err != nil {
		s.fail(w, err)
		return
	}
	s.handleSetup(w, r)
}

// cloneDir is where the Add project sheet clones by default, in full: the
// folder set as default, else ~/dev (ui/src/lib/addproject.ts cloneFolder,
// which this mirrors). "" without a home folder.
func (s *Server) cloneDir() string {
	if def := s.defaultFolder(); def != "" {
		return expandTilde(def)
	}
	// The same home the page gets from GET /v1/browse/repos, so the
	// checklist and the Clone field name one folder.
	home := homeRoot()
	if home == "" {
		return ""
	}
	return filepath.Join(home, "dev")
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
