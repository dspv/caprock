package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// The limits on PUT /v1/tabs: a viewer id is a short random token, and no
// workspace holds this many tabs.
const (
	maxTabViewer   = 64
	maxTabSessions = 500
)

// handlePutTabs is PUT /v1/tabs (03-contracts.md § Open tabs): a dashboard
// says which sessions it has a tab for, the whole list each time. A session
// in any viewer's list is never ended for idling (daemon/endidle.go).
func (s *Server) handlePutTabs(w http.ResponseWriter, r *http.Request) {
	if s.d.OpenTabs == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("open tabs are not kept by this daemon"))
		return
	}
	var body struct {
		Viewer   string   `json:"viewer"`
		Sessions []string `json:"sessions"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		s.failCode(w, http.StatusBadRequest, fmt.Errorf("parse body: %w", err))
		return
	}
	viewer := strings.TrimSpace(body.Viewer)
	if viewer == "" || len(viewer) > maxTabViewer {
		s.failCode(w, http.StatusBadRequest, fmt.Errorf("viewer must be 1 to %d characters", maxTabViewer))
		return
	}
	if len(body.Sessions) > maxTabSessions {
		s.failCode(w, http.StatusBadRequest, fmt.Errorf("at most %d sessions", maxTabSessions))
		return
	}
	ids := make([]string, 0, len(body.Sessions))
	seen := map[string]bool{}
	for _, id := range body.Sessions {
		id = strings.TrimSpace(id)
		if id == "" || len(id) > 200 || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if err := s.d.OpenTabs(viewer, ids); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
