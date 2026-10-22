package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/dspv/caprock/internal/mcpreg"
)

// MCPRegistrar reads and changes whether `caprock mcp` is registered with the
// user's coding agents (internal/mcpreg, ADR-078).
type MCPRegistrar interface {
	Statuses() []mcpreg.Status
	Executable() (string, error)
	Connect(ctx context.Context, agent string) (mcpreg.Status, error)
	Disconnect(ctx context.Context, agent string) (mcpreg.Status, error)
}

// mcpAgentsBody is GET /v1/mcp/agents.
type mcpAgentsBody struct {
	// Executable is the path Connect registers.
	Executable string `json:"executable,omitempty"`
	// Unstable says why Connect would refuse this path, when it would.
	Unstable string          `json:"unstable,omitempty"`
	Agents   []mcpreg.Status `json:"agents"`
}

// handleMCPAgents is each agent's registration: not installed, not
// connected, connected, or connected to a different command. A read of the
// agents' own config files; nothing is started.
func (s *Server) handleMCPAgents(w http.ResponseWriter, _ *http.Request) {
	if s.d.MCP == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "MCP registration is unavailable"})
		return
	}
	body := mcpAgentsBody{Agents: s.d.MCP.Statuses()}
	exe, err := s.d.MCP.Executable()
	body.Executable = exe
	if err != nil {
		body.Unstable = err.Error()
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) handleMCPConnect(w http.ResponseWriter, r *http.Request) {
	s.mcpChange(w, r, true)
}

func (s *Server) handleMCPDisconnect(w http.ResponseWriter, r *http.Request) {
	s.mcpChange(w, r, false)
}

// mcpChange runs Connect or Disconnect for the agent in the path: the agent's
// own CLI, on a click at the machine. A paired device is refused: it changes
// the machine's agent config, and a phone or another computer changes only
// what Caprock itself keeps (ADR-034, ADR-067).
func (s *Server) mcpChange(w http.ResponseWriter, r *http.Request, connect bool) {
	if s.d.MCP == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "MCP registration is unavailable"})
		return
	}
	if deviceFrom(r) != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "connecting your agents to Caprock happens on the machine Caprock runs on"})
		return
	}
	change := s.d.MCP.Disconnect
	if connect {
		change = s.d.MCP.Connect
	}
	st, err := change(r.Context(), r.PathValue("agent"))
	if err != nil {
		code := http.StatusBadGateway // the agent's CLI failed; its message is the error
		var cli *mcpreg.CLIError
		switch {
		case errors.Is(err, mcpreg.ErrUnknownAgent):
			code = http.StatusNotFound
		case errors.Is(err, mcpreg.ErrNotInstalled), errors.Is(err, mcpreg.ErrNoStablePath):
			code = http.StatusConflict
		case errors.As(err, &cli):
		default:
			code = http.StatusInternalServerError
		}
		writeJSON(w, code, map[string]any{"error": err.Error(), "agent": st})
		return
	}
	writeJSON(w, http.StatusOK, st)
}
