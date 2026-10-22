package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/dspv/caprock/internal/store"
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

// TabsAnswer is GET /v1/tabs: the tabs the computer has open, in tab-strip
// order, for the phone home's Continue (03-contracts.md § Open tabs).
type TabsAnswer struct {
	// Known is false when no viewer's report counts (none yet, or none for
	// a week): the phone then lists live sessions in a fixed order.
	Known bool `json:"known"`
	// At is when that viewer last reported, unix ms; 0 when not known.
	At int64 `json:"at"`
	// Sessions is the reported list as it came: tab-strip order, and ids
	// that are not sessions (a file, a page, a shell) included.
	Sessions []string `json:"sessions"`
	// Items is each of those that is a session in the store, in the same
	// order, as GET /v1/sessions describes it. Shells are left out.
	Items []SessionSummary `json:"items"`
}

// handleGetTabs is GET /v1/tabs: the list the phone mirrors. Only the
// computer's app reports tabs (PUT), so a phone asking reads the computer's.
func (s *Server) handleGetTabs(w http.ResponseWriter, r *http.Request) {
	if s.d.LatestTabs == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("open tabs are not kept by this daemon"))
		return
	}
	ctx := r.Context()
	ids, at, ok := s.d.LatestTabs()
	out := TabsAnswer{Known: ok, Sessions: []string{}, Items: []SessionSummary{}}
	if !ok {
		writeJSON(w, http.StatusOK, out)
		return
	}
	out.At = at
	out.Sessions = append(out.Sessions, ids...)
	for _, id := range ids {
		if s.d.Shells != nil && s.d.Shells.IsShell(id) {
			continue
		}
		sess, err := store.GetSession(ctx, s.d.Store.DB(), id)
		if err != nil {
			if strings.Contains(err.Error(), "no rows") {
				continue // a file's or a page's key, or a session since deleted
			}
			s.fail(w, err)
			return
		}
		sum, _, err := s.summarize(ctx, sess)
		if err != nil {
			s.fail(w, err)
			return
		}
		out.Items = append(out.Items, sum)
	}
	writeJSON(w, http.StatusOK, out)
}
