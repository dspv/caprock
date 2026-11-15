package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/store"
)

// The Jarvis digest (GET /v1/jarvis, ADR-094, .ai/03-contracts.md § Jarvis):
// one answer for a person running several agents at once — what needs them
// (a permission dialog, a question, an orchestrator approval, a loop) and
// every live agent with what it is doing now, its plan and what it cost
// today. Deterministic and built per request from what the daemon already
// reads for the Now screen: each live session's summary (summarize, whose
// event reads are kept per generation in recentCache), the loop detector's
// live alerts, the agent's own task list, the task runner's approvals and
// two sums over today's events. No model is asked; nothing is written.

// Jarvis agent states.
const (
	JarvisWorking = "working"
	JarvisWaiting = "waiting"
	JarvisIdle    = "idle"
	// JarvisStuck: the loop detector holds a live alert for the session.
	JarvisStuck = "stuck"
)

// Jarvis needs-you kinds, most urgent first.
const (
	NeedsPermission = "permission"
	NeedsQuestion   = "question"
	NeedsApproval   = "approval"
	NeedsLoop       = "loop"
)

// jarvisMax bounds the live sessions read, as the Work board's does.
const jarvisMax = 200

// jarvisTitleRunes and jarvisDetailRunes bound a needs-you line and its text.
const (
	jarvisTitleRunes  = 120
	jarvisDetailRunes = 600
)

// JarvisDigest is GET /v1/jarvis.
type JarvisDigest struct {
	// GeneratedAt is the daemon's clock (unix ms).
	GeneratedAt int64              `json:"generated_at"`
	Headline    JarvisHeadline     `json:"headline"`
	NeedsYou    []JarvisNeed       `json:"needs_you"`
	Agents      []JarvisAgent      `json:"agents"`
	Projects    []JarvisProjectRow `json:"projects"`
}

// JarvisHeadline counts the live sessions by state, and today's work across
// every session (the local day).
type JarvisHeadline struct {
	Working       int     `json:"working"`
	WaitingYou    int     `json:"waiting_you"`
	Stuck         int     `json:"stuck"`
	Live          int     `json:"live"`
	SessionsToday int     `json:"sessions_today"`
	CostTodayUSD  float64 `json:"cost_today_usd"`
}

// JarvisNeed is one thing waiting on the person.
type JarvisNeed struct {
	Kind string `json:"kind"`
	// SessionID is "" for an orchestrator approval with no session.
	SessionID string `json:"session_id"`
	Project   string `json:"project"`
	// Title is one short line in plain words.
	Title string `json:"title"`
	// Detail is the longer text: the question asked, the call's input, the
	// loop's repeated call.
	Detail string `json:"detail,omitempty"`
	// Since is when it started waiting (unix ms).
	Since        int64  `json:"since"`
	ApprovalID   string `json:"approval_id,omitempty"`
	Controllable bool   `json:"controllable"`
}

// JarvisAgent is one live session.
type JarvisAgent struct {
	SessionID string `json:"session_id"`
	Project   string `json:"project"`
	Dir       string `json:"dir"`
	Agent     string `json:"agent"`
	Title     string `json:"title"`
	State     string `json:"state"`
	// Now is what it is doing, "" when unknown.
	Now string `json:"now"`
	// Plan is nil when the agent keeps no task list.
	Plan           *JarvisPlan `json:"plan"`
	CostTodayUSD   float64     `json:"cost_today_usd"`
	StartedAt      int64       `json:"started_at"`
	LastActivityAt int64       `json:"last_activity_at"`
	// Controllable: Caprock started the session and holds its terminal, so
	// it may type into it (rule 7).
	Controllable bool `json:"controllable"`
}

// JarvisPlan is the agent's own task list.
type JarvisPlan struct {
	Done    int    `json:"done"`
	Total   int    `json:"total"`
	Current string `json:"current"`
}

// JarvisProjectRow is a project with live sessions.
type JarvisProjectRow struct {
	Name    string `json:"name"`
	Live    int    `json:"live"`
	Waiting int    `json:"waiting"`
}

func (s *Server) handleJarvis(w http.ResponseWriter, r *http.Request) {
	d, err := s.Jarvis(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// Jarvis builds the digest.
func (s *Server) Jarvis(ctx context.Context) (JarvisDigest, error) {
	now := s.d.Now()
	out := JarvisDigest{GeneratedAt: now.UnixMilli(), NeedsYou: []JarvisNeed{}, Agents: []JarvisAgent{}, Projects: []JarvisProjectRow{}}
	db := s.d.Store.DB()
	day, _ := s.rangeFrom("today")

	list, err := store.ListSessionsQuery(ctx, db, store.SessionQuery{Active: true}, jarvisMax)
	if err != nil {
		return out, err
	}
	var live []store.Session
	for _, sess := range list {
		if sess.Status == store.StatusEnded || sess.Agent == agents.KindShell || (s.d.Shells != nil && s.d.Shells.IsShell(sess.SessionID)) {
			continue
		}
		live = append(live, sess)
	}
	ids := make([]string, len(live))
	for i, sess := range live {
		ids[i] = sess.SessionID
	}
	today, err := store.SpendBySessionSince(ctx, db, ids, day)
	if err != nil {
		return out, err
	}
	if out.Headline.CostTodayUSD, out.Headline.SessionsToday, err = store.DaySpend(ctx, db, day); err != nil {
		return out, err
	}

	for _, sess := range live {
		gen, err := store.ReadEventsGen(ctx, db, sess.SessionID)
		if err != nil {
			return out, err
		}
		rec := s.recent.entry(sess.SessionID, gen)
		sum, last, err := s.summarizeAt(ctx, sess, rec)
		if err != nil {
			return out, err
		}
		plan, err := s.jarvisPlan(ctx, sess.SessionID, rec)
		if err != nil {
			return out, err
		}
		a := JarvisAgent{
			SessionID: sess.SessionID, Project: sess.Project, Dir: sess.Cwd, Agent: firstNonEmpty(sess.Agent, agents.AgentClaude),
			Title: sum.Description, State: jarvisState(sum), Plan: plan, CostTodayUSD: today[sess.SessionID],
			StartedAt: sess.StartedAt, LastActivityAt: max(sess.WorkedAt, sess.LastEventAt),
			Controllable: sess.Owned && s.d.Agents != nil && s.d.Agents.Holds(sess.SessionID),
		}
		a.Now = jarvisNow(sum.Activity, a.State, last)
		out.Agents = append(out.Agents, a)
		switch a.State {
		case JarvisWorking:
			out.Headline.Working++
		case JarvisWaiting:
			out.Headline.WaitingYou++
		case JarvisStuck:
			out.Headline.Stuck++
		}
		if n, ok := jarvisNeed(sum, a, last); ok {
			out.NeedsYou = append(out.NeedsYou, n)
		}
		if sum.Loop != nil {
			out.NeedsYou = append(out.NeedsYou, loopNeed(sum, a))
		}
	}
	out.Headline.Live = len(out.Agents)
	out.NeedsYou = append(out.NeedsYou, s.jarvisApprovals(ctx)...)

	// Waiting on you first, then stuck, working, idle; newest activity first
	// within a state.
	rank := map[string]int{JarvisWaiting: 0, JarvisStuck: 1, JarvisWorking: 2, JarvisIdle: 3}
	sort.SliceStable(out.Agents, func(i, j int) bool {
		x, y := out.Agents[i], out.Agents[j]
		if rank[x.State] != rank[y.State] {
			return rank[x.State] < rank[y.State]
		}
		return x.LastActivityAt > y.LastActivityAt
	})
	// Most urgent first; within a kind, the one waiting longest first.
	kind := map[string]int{NeedsPermission: 0, NeedsQuestion: 1, NeedsApproval: 2, NeedsLoop: 3}
	sort.SliceStable(out.NeedsYou, func(i, j int) bool {
		x, y := out.NeedsYou[i], out.NeedsYou[j]
		if kind[x.Kind] != kind[y.Kind] {
			return kind[x.Kind] < kind[y.Kind]
		}
		return x.Since < y.Since
	})
	out.Projects = jarvisProjects(out.Agents)
	return out, nil
}

// jarvisState reads the session's summary: a live loop alert is stuck, the
// Now screen's waiting-on-you is waiting, working (background subagents
// included) is working, and everything else — idle, done — is idle.
func jarvisState(sum SessionSummary) string {
	if sum.Loop != nil {
		return JarvisStuck
	}
	switch sum.Activity.Health {
	case narrate.HealthWaiting:
		return JarvisWaiting
	case narrate.HealthWorking, narrate.HealthLooping, narrate.HealthError:
		return JarvisWorking
	}
	return JarvisIdle
}

// jarvisNow is what the agent is doing: for one at work, its newest
// main-thread call as the cockpit names a subagent's ("Editing Cockpit.tsx",
// or the call's own description); otherwise, and when no call says more, the
// Now screen's phrase; an idle one is "Done".
func jarvisNow(act narrate.Activity, state string, last []event.Event) string {
	if state == JarvisWorking && act.Background == 0 {
		for i := len(last) - 1; i >= 0; i-- {
			e := last[i]
			if e.Kind != event.KindToolPre || e.AgentID != "" {
				continue
			}
			if doing, _ := subagentDoing(e.Tool, toolInputOf(e.Payload), ""); doing != "" {
				return doing
			}
			break
		}
	}
	// An idle agent's phrase is its last event in the past tense ("was
	// subagent finished"), which reads as noise in a list of agents: at its
	// prompt with nothing asked, it is done.
	if state == JarvisIdle {
		return "Done"
	}
	if act.Phrase == "" {
		return ""
	}
	return capitalize(act.Phrase)
}

// jarvisNeed is the session's needs-you item when it waits on the person:
// a permission dialog is "permission"; a question dialog, a plan to approve,
// a turn that ended asking something and one that stopped on an error are
// "question" — the agent stopped and wants a word from them.
func jarvisNeed(sum SessionSummary, a JarvisAgent, last []event.Event) (JarvisNeed, bool) {
	act := sum.Activity
	if act.Health != narrate.HealthWaiting {
		return JarvisNeed{}, false
	}
	n := JarvisNeed{SessionID: a.SessionID, Project: a.Project, Since: a.LastActivityAt, Controllable: a.Controllable, Kind: NeedsQuestion}
	if !act.At.IsZero() {
		n.Since = act.At.UnixMilli()
	}
	reason := ""
	if act.Need != nil {
		reason = act.Need.Reason
	}
	prompt, hasPrompt := lastPrompt(last)
	switch reason {
	case narrate.NeedPermission:
		n.Kind = NeedsPermission
		if hasPrompt {
			n.Title, n.Detail = permissionLine(prompt.Tool, toolInputOf(prompt.Payload))
		}
		if n.Title == "" {
			n.Title = capitalize(act.Phrase)
		}
	case narrate.NeedQuestion:
		if hasPrompt {
			n.Title, n.Detail = questionLine(toolInputOf(prompt.Payload))
		}
		if n.Title == "" {
			n.Title = "Asks you a question"
		}
	case narrate.NeedPlan:
		n.Title = "Has a plan for you to approve"
		if hasPrompt {
			var in struct {
				Plan string `json:"plan"`
			}
			_ = json.Unmarshal(toolInputOf(prompt.Payload), &in)
			n.Detail = clipText(in.Plan)
		}
	case narrate.NeedAsks:
		n.Title = oneLine(act.Need.Text, jarvisTitleRunes)
		if utf8.RuneCountInString(act.Need.Text) > jarvisTitleRunes || strings.Contains(act.Need.Text, "\n") {
			n.Detail = act.Need.Text
		}
		if n.Title == "" {
			n.Title = "Asks you something"
		}
	default:
		// An error stop ("stopped: rate limit"), or a waiting turn the
		// narration gave no reason for.
		n.Title = capitalize(act.Phrase)
	}
	n.Title = oneLine(n.Title, jarvisTitleRunes)
	return n, true
}

// loopNeed is the needs-you item for a live loop alert.
func loopNeed(sum SessionSummary, a JarvisAgent) JarvisNeed {
	la := sum.Loop
	what := firstOf(la.Sample, la.Tool, "the same call")
	n := JarvisNeed{Kind: NeedsLoop, SessionID: a.SessionID, Project: a.Project, Controllable: a.Controllable,
		Title: oneLine("Stuck repeating "+firstNonEmpty(la.Tool, "a call"), jarvisTitleRunes)}
	if la.Count > 0 {
		n.Title = oneLine("Stuck: ran "+firstNonEmpty(la.Tool, "the same call")+" "+strconv.Itoa(la.Count)+" times", jarvisTitleRunes)
	}
	n.Detail = clipText(what)
	switch {
	case !la.FirstTs.IsZero():
		n.Since = la.FirstTs.UnixMilli()
	case !la.Ts.IsZero():
		n.Since = la.Ts.UnixMilli()
	default:
		n.Since = a.LastActivityAt
	}
	return n
}

// jarvisApprovals is the task runner's needs-you column, when it is on.
// Its tasks belong to no session the digest can name, so session_id is "".
func (s *Server) jarvisApprovals(ctx context.Context) []JarvisNeed {
	if s.d.Tasks == nil || !s.d.Tasks.Enabled() {
		return nil
	}
	v, err := s.d.Tasks.Approvals(ctx)
	if err != nil {
		return nil
	}
	rows, _ := v.([]store.TaskRow)
	var out []JarvisNeed
	for _, t := range rows {
		out = append(out, JarvisNeed{Kind: NeedsApproval, Title: oneLine("Task to approve: "+t.Title, jarvisTitleRunes),
			Detail: t.Title, Since: t.UpdatedAt, ApprovalID: t.ID, Controllable: true})
	}
	return out
}

// jarvisPlan is the agent's own task list as done, total and the item in
// progress (else the first pending one); nil for an agent that keeps none.
// Kept per events generation, as the summary's own reads are.
func (s *Server) jarvisPlan(ctx context.Context, id string, rec *recentEntry) (*JarvisPlan, error) {
	list, err := readOnce(&rec.mu, &rec.todos, func() (store.TodoList, error) {
		return store.SessionTodos(ctx, s.d.Store.DB(), id)
	})
	if err != nil {
		return nil, err
	}
	return planOf(list), nil
}

// planOf folds a task list; cancelled items do not count.
func planOf(list store.TodoList) *JarvisPlan {
	p := &JarvisPlan{}
	pending := ""
	for _, it := range list.Items {
		switch it.Status {
		case "cancelled":
			continue
		case "completed":
			p.Done++
		case "in_progress":
			if p.Current == "" {
				p.Current = firstNonEmpty(it.Text, it.ActiveForm)
			}
		default:
			if pending == "" {
				pending = firstNonEmpty(it.Text, it.ActiveForm)
			}
		}
		p.Total++
	}
	if p.Total == 0 {
		return nil
	}
	if p.Current == "" {
		p.Current = pending
	}
	p.Current = oneLine(p.Current, jarvisTitleRunes)
	return p
}

// jarvisProjects is each project with live sessions, most live first.
func jarvisProjects(list []JarvisAgent) []JarvisProjectRow {
	idx := map[string]int{}
	out := []JarvisProjectRow{}
	for _, a := range list {
		i, ok := idx[a.Project]
		if !ok {
			i = len(out)
			idx[a.Project] = i
			out = append(out, JarvisProjectRow{Name: a.Project})
		}
		out[i].Live++
		if a.State == JarvisWaiting {
			out[i].Waiting++
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Live != out[j].Live {
			return out[i].Live > out[j].Live
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// lastPrompt is the newest permission prompt among the events.
func lastPrompt(last []event.Event) (event.Event, bool) {
	for i := len(last) - 1; i >= 0; i-- {
		if last[i].Kind == event.KindPermissionPrompt {
			return last[i], true
		}
	}
	return event.Event{}, false
}

// permissionLine says what a permission dialog asks for: "Wants to run: git
// push origin feat/x", and the call's whole input line as the detail.
func permissionLine(tool string, input json.RawMessage) (string, string) {
	var in map[string]any
	_ = json.Unmarshal(input, &in)
	str := func(k string) string { v, _ := in[k].(string); return strings.TrimSpace(v) }
	switch tool {
	case "Bash", "exec":
		if c := str("command"); c != "" {
			return "Wants to run: " + c, clipText(firstNonEmpty(str("description"), c))
		}
	case "Edit", "MultiEdit", "NotebookEdit":
		if f := callDetail(tool, input); f != "" {
			return "Wants to edit: " + f, str("file_path")
		}
	case "Write":
		if f := callDetail(tool, input); f != "" {
			return "Wants to write: " + f, str("file_path")
		}
	}
	if tool == "" {
		return "", ""
	}
	name := tool
	if strings.HasPrefix(tool, "mcp__") {
		if parts := strings.SplitN(strings.TrimPrefix(tool, "mcp__"), "__", 2); len(parts) == 2 {
			name = parts[0] + " " + parts[1]
		}
	}
	title := "Wants to use " + name
	if d := callDetail(tool, input); d != "" {
		title += ": " + d
	}
	return title, clipText(string(input))
}

// questionLine is an AskUserQuestion dialog's first question, and its
// options as the detail.
func questionLine(input json.RawMessage) (string, string) {
	var in struct {
		Questions []struct {
			Question string `json:"question"`
			Options  []struct {
				Label string `json:"label"`
			} `json:"options"`
		} `json:"questions"`
	}
	if json.Unmarshal(input, &in) != nil || len(in.Questions) == 0 {
		return "", ""
	}
	q := in.Questions[0]
	var labels []string
	for _, o := range q.Options {
		if o.Label != "" {
			labels = append(labels, o.Label)
		}
	}
	detail := q.Question
	if len(labels) > 0 {
		detail += "\n" + strings.Join(labels, " · ")
	}
	if len(in.Questions) > 1 {
		detail += "\n(+" + strconv.Itoa(len(in.Questions)-1) + " more)"
	}
	return q.Question, clipText(detail)
}

// toolInputOf is an event payload's tool_input.
func toolInputOf(payload json.RawMessage) json.RawMessage {
	var p struct {
		ToolInput json.RawMessage `json:"tool_input"`
	}
	_ = json.Unmarshal(payload, &p)
	return p.ToolInput
}

func capitalize(s string) string {
	r, n := utf8.DecodeRuneInString(s)
	if n == 0 {
		return s
	}
	return string(unicode.ToUpper(r)) + s[n:]
}

// clipText bounds a longer text to jarvisDetailRunes, keeping its lines.
func clipText(s string) string {
	n := jarvisDetailRunes
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

func firstOf(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
