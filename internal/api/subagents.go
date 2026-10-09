package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/toolcmd"
)

// SubagentNow is one subagent working in a session, as the agent cockpit
// lists it (GET /v1/sessions/{id}/subagents).
type SubagentNow struct {
	AgentID     string `json:"agent_id"`
	AgentType   string `json:"agent_type,omitempty"`
	Description string `json:"description,omitempty"`
	ToolCalls   int    `json:"tool_calls"`
	StartedAt   int64  `json:"started_at"`
	LastAt      int64  `json:"last_at"`
	// Tool and Detail are its newest call — the file, command, pattern or
	// URL on one short line — and ToolAt when it started (unix ms).
	Tool    string `json:"tool,omitempty"`
	Detail  string `json:"detail,omitempty"`
	ToolAt  int64  `json:"tool_at,omitempty"`
	Running bool   `json:"running"`
	Asking  bool   `json:"asking"`
	SubagentModel
}

// SubagentModel is the model a subagent runs on and what its own calls cost
// so far, from its transcript's turns.
type SubagentModel struct {
	// Model is its newest turn's model id, ModelDisplay the pricing table's
	// short name for it ("Haiku 4.5"); both omitted before its first turn.
	Model        string `json:"model,omitempty"`
	ModelDisplay string `json:"model_display,omitempty"`
	// CostUSD is omitted when unknown: no turn yet, or one the pricing
	// table could not price. Never a zero standing in for unknown.
	CostUSD *float64 `json:"cost_usd,omitempty"`
}

// SubagentDone is a subagent that finished lately.
type SubagentDone struct {
	AgentID     string `json:"agent_id"`
	AgentType   string `json:"agent_type,omitempty"`
	Description string `json:"description,omitempty"`
	ToolCalls   int    `json:"tool_calls"`
	// StartedAt is its first event in the window, StoppedAt its
	// SubagentStop (unix ms).
	StartedAt int64 `json:"started_at"`
	StoppedAt int64 `json:"stopped_at"`
	SubagentModel
}

// recentSubagents bounds the finished subagents listed.
const recentSubagents = 3

// SubagentsResponse is GET /v1/sessions/{id}/subagents.
type SubagentsResponse struct {
	Working []SubagentNow `json:"working"`
	// Finished is how many stopped within the same window after making a
	// tool call.
	Finished int `json:"finished"`
	// Recent is the newest of those, at most three, newest stop first.
	Recent []SubagentDone `json:"recent"`
	// CostUSD is what every subagent of the session has cost, over its whole
	// life; omitted when any of them is unknown.
	CostUSD *float64 `json:"cost_usd,omitempty"`
}

// handleSessionSubagents lists the subagents working in a session, under
// the rule live_subagents counts by (liveSubagentWindow), so the cockpit's
// list and the session's count agree. Computed in a few indexed queries:
// a parent whose subagents logged thousands of events is not paged through.
func (s *Server) handleSessionSubagents(w http.ResponseWriter, r *http.Request) {
	since := s.d.Now().Add(-liveSubagentWindow).UnixMilli()
	list, finished, err := store.SubagentsNow(r.Context(), s.d.Store.DB(), r.PathValue("id"), since)
	if err != nil {
		s.fail(w, err)
		return
	}
	id := r.PathValue("id")
	done, err := store.SubagentsDone(r.Context(), s.d.Store.DB(), id, since, recentSubagents)
	if err != nil {
		s.fail(w, err)
		return
	}
	spend, total, err := store.SubagentsSpend(r.Context(), s.d.Store.DB(), id)
	if err != nil {
		s.fail(w, err)
		return
	}
	model := func(agent string) SubagentModel {
		sp, ok := spend[agent]
		if !ok {
			return SubagentModel{}
		}
		m := SubagentModel{Model: sp.Model, ModelDisplay: s.modelDisplay(sp.Model)}
		if sp.Known {
			m.CostUSD = &sp.CostUSD
		}
		return m
	}
	resp := SubagentsResponse{Working: []SubagentNow{}, Finished: finished, Recent: []SubagentDone{}}
	if total.Known {
		resp.CostUSD = &total.CostUSD
	}
	for _, a := range done {
		resp.Recent = append(resp.Recent, SubagentDone{
			AgentID: a.AgentID, AgentType: a.AgentType, Description: oneLine(a.Description, 120),
			ToolCalls: a.ToolCalls, StartedAt: a.StartedAt, StoppedAt: a.StoppedAt, SubagentModel: model(a.AgentID),
		})
	}
	for _, a := range list {
		resp.Working = append(resp.Working, SubagentNow{
			AgentID: a.AgentID, AgentType: a.AgentType, Description: oneLine(a.Description, 120),
			ToolCalls: a.ToolCalls, StartedAt: a.StartedAt, LastAt: a.LastAt,
			Tool: a.Tool, Detail: callDetail(a.Tool, a.Input), ToolAt: a.ToolAt,
			Running: a.Running, Asking: a.Asking, SubagentModel: model(a.AgentID),
		})
	}
	writeJSON(w, http.StatusOK, resp)
}

// callDetail is the short line a call was given, as the cockpit's tool list
// shows it (ui/src/lib/cockpit.ts toolDetail): a file's name, a command's
// first line, a pattern, a URL.
func callDetail(tool string, input json.RawMessage) string {
	var in map[string]any
	_ = json.Unmarshal(input, &in)
	str := func(k string) string { s, _ := in[k].(string); return s }
	for _, k := range []string{"file_path", "notebook_path", "filePath"} {
		if f := str(k); f != "" {
			return baseOf(f)
		}
	}
	if c := str("command"); c != "" {
		// Codex's exec carries a script: the line is what it ran.
		return oneLine(toolcmd.Command(tool, c), 80)
	}
	for _, k := range []string{"pattern", "query", "url", "description", "subagent_type", "skill", "prompt"} {
		if v := str(k); v != "" {
			return oneLine(v, 80)
		}
	}
	if p := str("path"); p != "" {
		return baseOf(p)
	}
	if strings.HasPrefix(tool, "mcp__") {
		// What the cockpit's list shows for an MCP call with no short input.
		if parts := strings.SplitN(strings.TrimPrefix(tool, "mcp__"), "__", 2); len(parts) == 2 {
			return parts[0] + "·" + parts[1]
		}
	}
	return ""
}

func baseOf(p string) string {
	p = strings.TrimRight(p, `/\`)
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		return p[i+1:]
	}
	return p
}

// oneLine is the first line of s, its spaces collapsed, clipped to n runes.
func oneLine(s string, n int) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}
