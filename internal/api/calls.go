package api

import (
	"net/http"
	"strconv"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// SessionCall is one entry of GET /v1/sessions/{id}/calls: a priced model
// call of the main thread, as the cockpit's spend scrubber reads it.
type SessionCall struct {
	ID           int64             `json:"id"`
	Ts           int64             `json:"ts"`
	Model        string            `json:"model,omitempty"`
	ModelDisplay string            `json:"model_display,omitempty"`
	CostUSD      float64           `json:"cost_usd"`
	Tokens       *event.TokenDelta `json:"tokens,omitempty"`
	Tools        []CallTool        `json:"tools,omitempty"`
	ToolCount    int               `json:"tool_count,omitempty"`
}

// CallTool is a tool call a model call asked for, with the short line the
// cockpit's tool list gives it.
type CallTool struct {
	Tool   string `json:"tool"`
	Detail string `json:"detail,omitempty"`
}

// handleSessionCalls returns a session's priced main-thread model calls,
// oldest first: the whole series the spark at the top of the cockpit only
// shows the end of. Lean on purpose — no prose, no tool results — so a
// session of thousands of calls is one small response.
func (s *Server) handleSessionCalls(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	calls, err := store.SessionCalls(r.Context(), s.d.Store.DB(), r.PathValue("id"), limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	out := make([]SessionCall, 0, len(calls))
	display := map[string]string{}
	for _, c := range calls {
		d, ok := display[c.Model]
		if !ok {
			d = s.modelDisplay(c.Model)
			display[c.Model] = d
		}
		sc := SessionCall{ID: c.ID, Ts: c.Ts, Model: c.Model, ModelDisplay: d, CostUSD: c.CostUSD, Tokens: c.Tokens, ToolCount: c.ToolCount}
		for _, t := range c.Tools {
			sc.Tools = append(sc.Tools, CallTool{Tool: t.Tool, Detail: callDetail(t.Tool, t.Input)})
		}
		out = append(out, sc)
	}
	writeJSON(w, http.StatusOK, out)
}
