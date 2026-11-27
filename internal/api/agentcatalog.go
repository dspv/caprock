package api

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/dspv/caprock/internal/agentcat"
	"github.com/dspv/caprock/internal/config"
)

// AgentCatalog is what the agent pickers read and the custom agents are kept
// in (ADR-046). The daemon implements it; the API only routes and gates.
type AgentCatalog interface {
	// Catalog lists every agent Caprock knows here, built-in and custom, with
	// what each is missing.
	Catalog() CatalogResponse
	// Custom is the stored list of custom agents.
	Custom() []config.CustomAgent
	// SetCustom replaces it with a list already validated.
	SetCustom(list []config.CustomAgent) error
}

// CatalogResponse is GET /v1/agents/catalog.
type CatalogResponse struct {
	Agents []agentcat.Entry `json:"agents"`
	// Home is the folder a setup shell tab opens in.
	Home string `json:"home,omitempty"`
}

func (s *Server) handleAgentCatalog(w http.ResponseWriter, _ *http.Request) {
	if s.d.Catalog == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "the agent catalog is unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, s.d.Catalog.Catalog())
}

type customAgentsBody struct {
	Agents []config.CustomAgent `json:"agents"`
}

func (s *Server) handleCustomAgents(w http.ResponseWriter, _ *http.Request) {
	if s.d.Catalog == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "custom agents are unavailable"})
		return
	}
	list := s.d.Catalog.Custom()
	if list == nil {
		list = []config.CustomAgent{}
	}
	writeJSON(w, http.StatusOK, customAgentsBody{Agents: list})
}

// handlePutCustomAgents replaces the custom agents. Free, with no licence
// (owner decision, 2026-11-27: parity with Orca). A paired device may not set one: a custom agent is a command this machine
// will run, and a phone starts only the agents set up at the machine
// (ADR-034).
func (s *Server) handlePutCustomAgents(w http.ResponseWriter, r *http.Request) {
	if s.d.Catalog == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "custom agents are unavailable"})
		return
	}
	if deviceFrom(r) != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "custom agents are set up on the machine Caprock runs on"})
		return
	}
	var body struct {
		Agents []config.CustomAgent `json:"agents"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<18)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body is {"agents": [{name, command, args?, models?}]}`})
		return
	}
	list, err := agentcat.ValidateCustom(body.Agents)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := s.d.Catalog.SetCustom(list); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, customAgentsBody{Agents: list})
}
