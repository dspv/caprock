package api

import (
	"context"
	"errors"
	"net/http"
	"os"
	"time"

	"github.com/dspv/caprock/internal/license"
	"github.com/dspv/caprock/internal/store"
)

// ToolDrillResponse is GET /v1/tools/drill: one tool's calls grouped by what
// they were about. Contract: .ai/03-contracts.md.
//
// The groups and their call counts are free. What came back — bytes, failure
// rates, the per-group trend and the hints — is Premium (ADR-022), and is
// removed here, on the server, when the licence is not active: a gate the page
// enforces alone is a gate anyone can open from the console. One hint, the
// strongest, is sent in full either way as Teaser, so a reader without a
// licence sees the kind of thing they would get rather than a blur.
type ToolDrillResponse struct {
	store.ToolDrill
	Range  string           `json:"range"`
	Locked bool             `json:"locked"`
	Teaser *store.DrillHint `json:"teaser,omitempty"`
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
	writeJSON(w, http.StatusOK, s.gateDrill(v.(store.ToolDrill), label))
}

// gateDrill strips the Premium half of a drill without a licence. The cached
// value is shared, so it is copied, never edited.
func (s *Server) gateDrill(d store.ToolDrill, label string) ToolDrillResponse {
	licensed := false
	if s.d.Settings != nil {
		licensed = license.Parse(s.d.Settings.Get().LicenseKey, s.d.Now()).Active
	}
	resp := ToolDrillResponse{ToolDrill: d, Range: label}
	if licensed {
		return resp
	}
	resp.Locked = true
	if len(d.Hints) > 0 {
		h := d.Hints[0]
		resp.Teaser = &h
	}
	resp.Hints = nil
	resp.Results, resp.Failures, resp.Bytes = 0, 0, 0
	resp.TrendFromMs, resp.TrendWidthMs = 0, 0
	rows := make([]store.DrillRow, len(d.Rows))
	for i, r := range d.Rows {
		rows[i] = store.DrillRow{Key: r.Key, Calls: r.Calls}
	}
	resp.Rows = rows
	return resp
}
