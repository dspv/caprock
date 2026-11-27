package api

import (
	"context"
	"errors"
	"net/http"
	"os"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// ToolDrillResponse is GET /v1/tools/drill: one tool's calls grouped by what
// they were about. Contract: .ai/03-contracts.md.
//
// All of it — the groups, their call counts, what came back, failure rates,
// the per-group trend and the hints — is free (2026-11-27, ADR-022 amended:
// Caprock is free for one person).
type ToolDrillResponse struct {
	store.ToolDrill
	Range string `json:"range"`
}

// drillTTL is how long a drill may be reused: a tool's all-time breakdown
// costs about a second on a large database and changes by a call at a time.
const drillTTL = 60 * time.Second

func (s *Server) handleToolDrill(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	tool := q.Get("tool")
	if tool == "" || len(tool) > 200 {
		s.failCode(w, http.StatusBadRequest, errors.New("tool is required"))
		return
	}
	agent, err := agentFilter(q.Get("agent"))
	if err != nil {
		s.failCode(w, http.StatusBadRequest, err)
		return
	}
	from, label := s.rangeFrom(q.Get("range"))
	key := "drill:" + label + ":" + string(agent) + ":" + tool
	v, err := s.drill.get(r.Context(), key, func() (any, error) {
		home, _ := os.UserHomeDir()
		return store.ToolDrillStats(context.WithoutCancel(r.Context()), s.d.Store.DB(), store.DrillOptions{
			Tool: tool, FromMs: from, ToMs: s.d.Now().UnixMilli(), Agent: agent, Home: home,
		})
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ToolDrillResponse{ToolDrill: v.(store.ToolDrill), Range: label})
}
