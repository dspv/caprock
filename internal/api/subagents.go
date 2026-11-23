package api

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/event"
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
	Tool   string `json:"tool,omitempty"`
	Detail string `json:"detail,omitempty"`
	ToolAt int64  `json:"tool_at,omitempty"`
	// Doing is roughly what it is doing now, at most 60 runes (subagentDoing),
	// and DoingFrom where that came from: "call" (its newest call's own
	// description), "tool" (its tool and target) or "task" (what it was
	// spawned to do). Both omitted when none of them says anything.
	Doing     string `json:"doing,omitempty"`
	DoingFrom string `json:"doing_from,omitempty"`
	Running   bool   `json:"running"`
	Asking    bool   `json:"asking"`
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
	// EndedBy, for one that never sent its SubagentStop, is why it is read
	// as stopped (store.SubagentBounds): "restart" — its parent's process
	// started again; "ended" — the session ended; "quiet" — silent past
	// store.SubagentQuietMax behind an idle parent. StoppedAt is then the
	// restart, else its newest event. Absent for a SubagentStop.
	EndedBy string `json:"ended_by,omitempty"`
	SubagentModel
}

// recentSubagents is how many finished subagents are listed by default;
// ?recent= asks for up to maxRecentSubagents (the cockpit's "+N finished",
// opened).
const (
	recentSubagents    = 3
	maxRecentSubagents = 30
)

// SubagentsResponse is GET /v1/sessions/{id}/subagents.
type SubagentsResponse struct {
	Working []SubagentNow `json:"working"`
	// Finished is how many stopped within the same window after making a
	// tool call.
	Finished int `json:"finished"`
	// Recent is the newest of those, three unless ?recent= asks for more
	// (at most 30), newest stop first.
	Recent []SubagentDone `json:"recent"`
	// CostUSD is what every subagent of the session has cost, over its whole
	// life; omitted when any of them is unknown.
	CostUSD *float64 `json:"cost_usd,omitempty"`
	// Hour is how many subagents worked in each minute of the last hour;
	// only with ?hour=1 (the cockpit's chart).
	Hour *SubagentHour `json:"hour,omitempty"`
}

// SubagentHour is the subagent count over the last hour, a minute a step.
type SubagentHour struct {
	// Start is the first step's start (unix ms, on a minute); the last step
	// is the minute now is in.
	Start int64 `json:"start"`
	Step  int64 `json:"step_ms"`
	// Counts holds how many subagents worked at some moment of each step,
	// oldest first; Peak is the largest.
	Counts []int `json:"counts"`
	Peak   int   `json:"peak"`
}

// subagentHourSteps is the chart's length: sixty one-minute steps.
const subagentHourSteps = 60

// subagentHour counts the session's subagents per minute over the last
// hour. Agents are read from a live window before the hour too, so one that
// started before it and was still working shows from the first minute.
func (s *Server) subagentHour(r *http.Request, id string) (*SubagentHour, error) {
	now := s.d.Now().UnixMilli()
	step := time.Minute.Milliseconds()
	start := now - now%step - step*(subagentHourSteps-1)
	live := s.d.Now().Add(-liveSubagentWindow).UnixMilli()
	spans, err := store.SubagentSpans(r.Context(), s.d.Store.DB(), id, start-liveSubagentWindow.Milliseconds(), live, now)
	if err != nil {
		return nil, err
	}
	h := &SubagentHour{Start: start, Step: step, Counts: store.SubagentCounts(spans, start, step, subagentHourSteps)}
	for _, n := range h.Counts {
		h.Peak = max(h.Peak, n)
	}
	return h, nil
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
	recent, _ := strconv.Atoi(r.URL.Query().Get("recent"))
	if recent <= 0 {
		recent = recentSubagents
	}
	done, err := store.SubagentsDone(r.Context(), s.d.Store.DB(), id, since, min(recent, maxRecentSubagents))
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
			ToolCalls: a.ToolCalls, StartedAt: a.StartedAt, StoppedAt: a.StoppedAt, EndedBy: a.Lost, SubagentModel: model(a.AgentID),
		})
	}
	for _, a := range list {
		doing, from := subagentDoing(a.Tool, a.Input, a.Description)
		resp.Working = append(resp.Working, SubagentNow{
			AgentID: a.AgentID, AgentType: a.AgentType, Description: oneLine(a.Description, 120),
			ToolCalls: a.ToolCalls, StartedAt: a.StartedAt, LastAt: a.LastAt,
			Tool: a.Tool, Detail: callDetail(a.Tool, a.Input), ToolAt: a.ToolAt,
			Doing: doing, DoingFrom: from,
			Running: a.Running, Asking: a.Asking, SubagentModel: model(a.AgentID),
		})
	}
	if r.URL.Query().Get("hour") == "1" {
		if resp.Hour, err = s.subagentHour(r, id); err != nil {
			s.fail(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// callDetail is the short line a call was given, as the cockpit's tool list
// shows it (ui/src/lib/cockpit.ts toolDetail): a file's name, what a command
// was for (its description) or else the command with its noise stripped
// (quietCommand), a pattern, a URL.
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
		// Claude Code's Bash says what the command is for: "Run the tests"
		// says more than "cd /Users/…/agent-x && npx vitest run".
		if d := strings.TrimSpace(str("description")); d != "" {
			return oneLine(d, 80)
		}
		// Codex's exec carries a script: the line is what it ran.
		return oneLine(quietCommand(toolcmd.Command(tool, c)), 80)
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

// callCommand is the command a call ran, for the hover behind its short
// line: "" when the call ran none or its line already is the command.
// Clipped to 1000 runes, its lines kept.
func callCommand(tool string, input json.RawMessage, detail string) string {
	var in struct {
		Command string `json:"command"`
	}
	if json.Unmarshal(input, &in) != nil || in.Command == "" {
		return ""
	}
	c := strings.TrimSpace(toolcmd.Command(tool, in.Command))
	if c == "" || c == detail {
		return ""
	}
	if r := []rune(c); len(r) > 1000 {
		return string(r[:999]) + "…"
	}
	return c
}

var (
	// A leading `cd <dir> &&` or `cd <dir>;`, the dir bare or quoted.
	leadingCd = regexp.MustCompile(`^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*`)
	// `git -C <dir>`: the folder is where it ran, not what it did.
	gitDashC = regexp.MustCompile(`\bgit\s+-C\s+(?:"[^"]*"|'[^']*'|\S+)`)
	// An absolute path under a home folder, after a space, quote, = or (.
	homePath = regexp.MustCompile(`(^|[\s=:'"(])(/(?:Users|home)/[^\s'"();&|]+)`)
)

// quietCommand is a command line without the parts that say where it ran
// rather than what it did: leading `cd <dir> &&` hops dropped, `git -C <dir>`
// read as `git`, a path inside a worktree (…/.claude/worktrees/<name>/) made
// relative to it and any other home path cut to its last two folders. Its UI
// twin is quietCommand in ui/src/lib/cockpit.ts.
func quietCommand(c string) string {
	for {
		loc := leadingCd.FindStringIndex(c)
		if loc == nil || loc[1] >= len(c) {
			break
		}
		c = c[loc[1]:]
	}
	c = gitDashC.ReplaceAllString(c, "git")
	return homePath.ReplaceAllStringFunc(c, func(m string) string {
		sub := homePath.FindStringSubmatch(m)
		return sub[1] + shortHomePath(sub[2])
	})
}

// shortHomePath reads /Users/me/dev/app/.claude/worktrees/x/ui/a.ts as
// ui/a.ts, /Users/me/dev/app/internal/api as …/internal/api and /Users/me/dev
// as ~/dev.
func shortHomePath(p string) string {
	const wt = "/.claude/worktrees/"
	if i := strings.Index(p, wt); i >= 0 {
		rest := p[i+len(wt):]
		if j := strings.IndexByte(rest, '/'); j >= 0 && j+1 < len(rest) {
			return rest[j+1:]
		}
		return "."
	}
	// segs[0] is Users or home, segs[1] the user.
	segs := strings.FieldsFunc(p, func(r rune) bool { return r == '/' })
	if len(segs) <= 4 {
		return "~/" + strings.Join(segs[2:], "/")
	}
	return "…/" + strings.Join(segs[len(segs)-2:], "/")
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

// SubagentCallView is one call in a subagent's activity feed.
type SubagentCallView struct {
	// ID is the call's event id, the cursor ?before= pages by.
	ID        int64  `json:"id"`
	ToolUseID string `json:"tool_use_id,omitempty"`
	Tool      string `json:"tool"`
	// Detail is its short line, as the cockpit's tool list writes it.
	Detail string `json:"detail,omitempty"`
	// Command is the command it ran when Detail is not that command (its
	// description, or the command with its noise stripped): for the hover.
	Command   string `json:"command,omitempty"`
	StartedAt int64  `json:"started_at"`
	// EndedAt is omitted while it has no result.
	EndedAt int64 `json:"ended_at,omitempty"`
	Error   bool  `json:"error,omitempty"`
}

// SubagentToolCost is one tool kind's share of a subagent's spend.
type SubagentToolCost struct {
	// Tool is empty for the turns that called no tool (they only wrote).
	Tool  string `json:"tool"`
	Calls int    `json:"calls"`
	// CostUSD is omitted when a turn behind it was not priced.
	CostUSD *float64 `json:"cost_usd,omitempty"`
}

// SubagentStats are a subagent's own numbers.
type SubagentStats struct {
	ToolCalls  int                `json:"tool_calls"`
	Turns      int                `json:"turns"`
	Tokens     event.TokenDelta   `json:"tokens"`
	DurationMs int64              `json:"duration_ms"`
	ByTool     []SubagentToolCost `json:"by_tool"`
	SubagentModel
}

// SubagentDetail is GET /v1/sessions/{id}/subagents/{agent}: one subagent
// opened up — the task its parent gave it, its calls, what it answered and
// its numbers.
type SubagentDetail struct {
	AgentID      string `json:"agent_id"`
	AgentType    string `json:"agent_type,omitempty"`
	Description  string `json:"description,omitempty"`
	Prompt       string `json:"prompt,omitempty"`
	SubagentType string `json:"subagent_type,omitempty"`
	// ParentToolUseID is the parent's Agent/Task call that launched it.
	ParentToolUseID string `json:"parent_tool_use_id,omitempty"`
	Background      bool   `json:"background,omitempty"`
	// State is "working", "finished" (its newest event is its
	// SubagentStop) or "quiet" (neither, and nothing heard for longer than
	// the live window, or read as stopped without its SubagentStop: EndedBy).
	State string `json:"state"`
	// EndedBy, with state quiet, is why it is read as stopped though heard
	// from within the window (store.SubagentBounds): "restart", "ended" or
	// "quiet", as SubagentDone says it.
	EndedBy   string `json:"ended_by,omitempty"`
	Asking    bool   `json:"asking"`
	StartedAt int64  `json:"started_at"`
	LastAt    int64  `json:"last_at"`
	StoppedAt int64  `json:"stopped_at,omitempty"`
	Result    string `json:"result,omitempty"`
	// Calls are the newest `limit` calls before the cursor, oldest first;
	// Earlier is how many older ones there are.
	Calls   []SubagentCallView `json:"calls"`
	Earlier int                `json:"earlier"`
	Stats   SubagentStats      `json:"stats"`
}

const (
	subagentFeedDefault = 30
	subagentFeedMax     = 500
	subagentByTool      = 4
)

// handleSubagentDetail opens one subagent of a session. Read once when the
// cockpit expands its row (and again when it stops); the live socket carries
// its calls in between.
func (s *Server) handleSubagentDetail(w http.ResponseWriter, r *http.Request) {
	tr, ok, err := store.SubagentTrailOf(r.Context(), s.d.Store.DB(), r.PathValue("id"), r.PathValue("agent"))
	if err != nil {
		s.fail(w, err)
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such subagent in this session"})
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = subagentFeedDefault
	}
	limit = min(limit, subagentFeedMax)
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	end := len(tr.Calls)
	if before > 0 {
		// Calls are in time order and ids grow with it within one plane;
		// the cursor is the first call shown, so cut at its position.
		for i, c := range tr.Calls {
			if c.ID == before {
				end = i
				break
			}
		}
	}
	start := max(0, end-limit)
	d := SubagentDetail{
		AgentID: tr.AgentID, AgentType: tr.AgentType, Description: tr.Description, Prompt: tr.Prompt,
		SubagentType: tr.SubagentType, ParentToolUseID: tr.ParentToolUseID, Background: tr.Background,
		Asking: tr.Asking, StartedAt: tr.StartedAt, LastAt: tr.LastAt, StoppedAt: tr.StoppedAt, Result: tr.Result,
		Calls: make([]SubagentCallView, 0, end-start), Earlier: start,
	}
	switch {
	case tr.StoppedAt > 0:
		d.State = "finished"
	case tr.LastAt >= s.d.Now().Add(-liveSubagentWindow).UnixMilli():
		d.State = "working"
		// One whose parent's process started again since, whose session
		// ended, or that went quiet behind an idle parent will never send
		// its SubagentStop: the list reads it stopped, and so does this.
		b, err := store.SubagentBoundsOf(r.Context(), s.d.Store.DB(), r.PathValue("id"), s.d.Now().Add(-liveSubagentWindow).UnixMilli(), s.d.Now().UnixMilli())
		if err != nil {
			s.fail(w, err)
			return
		}
		pending := len(tr.Calls) > 0 && tr.Calls[len(tr.Calls)-1].EndedAt == 0
		if lost := b.Lost(tr.LastAt, pending); lost != "" {
			d.State, d.EndedBy = "quiet", lost
		}
	default:
		d.State = "quiet"
	}
	for _, c := range tr.Calls[start:end] {
		detail := callDetail(c.Tool, c.Input)
		d.Calls = append(d.Calls, SubagentCallView{
			ID: c.ID, ToolUseID: c.ToolUseID, Tool: c.Tool, Detail: detail, Command: callCommand(c.Tool, c.Input, detail),
			StartedAt: c.StartedAt, EndedAt: c.EndedAt, Error: c.Error,
		})
	}
	until := tr.LastAt
	if d.State == "working" {
		until = s.d.Now().UnixMilli()
	}
	d.Stats = SubagentStats{
		ToolCalls: len(tr.Calls), Turns: tr.Turns, DurationMs: max(0, until-tr.StartedAt),
		Tokens: event.TokenDelta{In: tr.TokensIn, Out: tr.TokensOut, CacheRead: tr.CacheRead, CacheWrite: tr.CacheWrite},
		ByTool: []SubagentToolCost{}, SubagentModel: SubagentModel{Model: tr.Model, ModelDisplay: s.modelDisplay(tr.Model)},
	}
	if tr.CostKnown {
		v := tr.CostUSD
		d.Stats.CostUSD = &v
	}
	for _, t := range tr.ByTool {
		if len(d.Stats.ByTool) == subagentByTool {
			break
		}
		tc := SubagentToolCost{Tool: t.Tool, Calls: t.Calls}
		if t.Known && tr.Turns > 0 {
			v := t.CostUSD
			tc.CostUSD = &v
		}
		d.Stats.ByTool = append(d.Stats.ByTool, tc)
	}
	writeJSON(w, http.StatusOK, d)
}
