package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/dspv/caprock/internal/store"
)

// maxPipelineRoots bounds the folders one request may name: clones of one
// GitHub repository are a handful, never hundreds.
const maxPipelineRoots = 32

// handlePipelineAgents answers GET /v1/pipeline/agents?repo=<root>[&repo=…]:
// the Pipeline's two agent figures for the sessions in those folders — what
// an hour of agent work costs and how many agents worked (.ai/03-contracts.md
// § Pipeline agents). Cached per folder set and local day (pipeAgentsTTL),
// the days before today for longer (pipeAgentsPastTTL).
func (s *Server) handlePipelineAgents(w http.ResponseWriter, r *http.Request) {
	var roots []string
	for _, v := range r.URL.Query()["repo"] {
		if v != "" {
			roots = append(roots, v)
		}
	}
	if len(roots) == 0 {
		s.failCode(w, http.StatusBadRequest, errors.New("repo is required"))
		return
	}
	if len(roots) > maxPipelineRoots {
		s.failCode(w, http.StatusBadRequest, errors.New("too many repo folders"))
		return
	}
	ctx := r.Context()
	from, _ := s.rangeFrom("today")
	key := "pipeagents|" + strconv.FormatInt(from, 10) + "|" + store.RepoRootsKey(roots)
	v, err := s.pipeAgents.get(ctx, key, func() (any, error) {
		bg := context.WithoutCancel(ctx)
		now := s.d.Now()
		past, err := s.pipeAgentsPast.get(bg, key, func() (any, error) {
			return store.RepoAgentsBefore(bg, s.d.Store.DB(), now, roots)
		})
		if err != nil {
			return nil, err
		}
		return store.RepoAgentsAt(bg, s.d.Store.DB(), now, roots, past.(*store.RepoAgentsPast))
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}
