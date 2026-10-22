package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// Bounds on what a tool returns: a page an agent can read in one go.
const (
	defaultLimit = 10
	maxLimit     = 50
	noteRunes    = 1500
	summaryRunes = 600
	// memoryCandidates is how many memories search_memories returns by
	// default: enough candidates for the calling agent to judge by meaning,
	// each with a short summary (candidateRunes).
	memoryCandidates = 30
	candidateRunes   = 200
	maxDecisions     = 100
	maxFiles         = 40
	maxLinks         = 30
	maxTopics        = 60
	maxCostDays      = 90
	sampleRunes      = 200
	maxCIRuns        = 12
	maxFailedJobs    = 8
)

// Tools is what `caprock mcp` offers. cwd is the directory the agent started
// the server in: the repository a tool means when it is not given one.
func Tools(c *Client, cwd string) []Tool {
	t := &tools{c: c, cwd: cwd, now: time.Now}
	return t.list()
}

type tools struct {
	c   *Client
	cwd string
	now func() time.Time
}

// --- schema helpers ---

func obj(props map[string]any, required ...string) map[string]any {
	s := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func str(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }

// intArg is a count from 1 to hi.
func intArg(desc string, hi int) map[string]any {
	return map[string]any{"type": "integer", "description": desc, "minimum": 1, "maximum": hi}
}

func boolArg(desc string) map[string]any {
	return map[string]any{"type": "boolean", "description": desc}
}

const repoDesc = "A directory inside the repository; defaults to the directory this server was started in (normally the project the agent is working in)."

func (t *tools) list() []Tool {
	limit := intArg(fmt.Sprintf("How many to return (default %d, at most %d).", defaultLimit, maxLimit), maxLimit)
	return []Tool{
		{
			Name:  "search_memories",
			Title: "Search Second Brain",
			Description: "Search the user's Second Brain: decisions, findings and notes kept from earlier coding sessions, across every project or one. " +
				"Returns up to 30 ranked candidates (any word matches; rarer words, and hits in a title or its English keywords, rank higher; " +
				"a few synonyms such as PR/pull request, cost/price/spend and decision/rule are matched; typos are tolerated), " +
				"each with kind, date, project, keywords and a short summary: judge by meaning which ones answer the question, then read one with get_memory. " +
				"Titles are often in the user's own language, not English, while keywords are English. If nothing fits, rephrase and search again: " +
				"other words, fewer words, a synonym, the product or component name, or words in the user's language. " +
				"A memory marked superseded_by is no longer current: the id named replaces it.",
			Schema: obj(map[string]any{
				"query":   str("Words to look for. Empty lists the newest memories."),
				"project": str("Keep one project's memories (its name, e.g. the repository folder's name). Omit for all."),
				"limit":   intArg(fmt.Sprintf("How many to return (default %d, at most %d).", memoryCandidates, maxLimit), maxLimit),
			}),
			Call: t.searchMemories,
		},
		{
			Name:  "current_decisions",
			Title: "Current decisions",
			Description: "The decisions in force for a project, newest first: every decision in Second Brain that no newer one supersedes. " +
				"Read this before changing direction on something the user already decided.",
			Schema: obj(map[string]any{
				"project": str("The project's name (the repository folder's name). Omit for the repository this server was started in."),
				"limit":   intArg(fmt.Sprintf("How many (default 50, at most %d).", maxDecisions), maxDecisions),
			}),
			Call: t.currentDecisions,
		},
		{
			Name:        "get_memory",
			Title:       "Read one memory",
			Description: "One Second Brain memory in full, with what it is linked to (topics, people, projects, related memories).",
			Schema:      obj(map[string]any{"id": map[string]any{"type": "integer", "description": "The memory's id, from search_memories."}}, "id"),
			Call:        t.getMemory,
		},
		{
			Name:        "memory_topics",
			Title:       "Second Brain topics",
			Description: "The topics Second Brain has memories about, most-linked first, and how many memories each project holds.",
			Schema:      obj(map[string]any{"project": str("Keep one project's topics. Omit for all.")}),
			Call:        t.memoryTopics,
		},
		{
			Name:  "next_session_handoff",
			Title: "What the next session gets",
			Description: "What Caprock hands a new session started in a repository: the Second Brain memories it carries, " +
				"whether the handoff is switched on, and when the passage it would quote was written.",
			Schema: obj(map[string]any{"repo": str(repoDesc)}),
			Call:   t.handoff,
		},
		{
			Name:  "recent_sessions",
			Title: "Recent sessions",
			Description: "Recent coding-agent sessions (Claude Code, Codex, OpenCode, Gemini and others) in a repository, newest first: " +
				"title, status, branch, model, what it is doing, cost and tokens, and a loop alert when one is active.",
			Schema: obj(map[string]any{
				"repo":      str(repoDesc),
				"all_repos": boolArg("Every repository instead of one."),
				"limit":     limit,
			}),
			Call: t.recentSessions,
		},
		{
			Name:        "session_summary",
			Title:       "What a session did",
			Description: "One session: its title and description, status, branch, cost and tokens, turns and tool calls, the files it touched and the pull requests it opened.",
			Schema:      obj(map[string]any{"session_id": str("The session's id, from recent_sessions.")}, "session_id"),
			Call:        t.sessionSummary,
		},
		{
			Name:        "session_prose",
			Title:       "What a session wrote",
			Description: "The prose the agent wrote in a session (its answers and explanations, not tool output), newest first. Notes marked fragment read as mid-thought.",
			Schema: obj(map[string]any{
				"session_id": str("The session's id, from recent_sessions."),
				"limit":      intArg("How many passages (default 5, at most 20).", 20),
			}, "session_id"),
			Call: t.sessionProse,
		},
		{
			Name:        "search_prose",
			Title:       "Search what agents wrote",
			Description: "Search the prose agents wrote across every session on this computer — \"which session explained the SSO change?\" Newest first.",
			Schema:      obj(map[string]any{"query": str("Words to look for."), "limit": limit}, "query"),
			Call:        t.searchProse,
		},
		{
			Name:        "cost",
			Title:       "Cost and tokens",
			Description: "Agent spend and tokens per day for a repository (or all of them), with totals by model. Figures are Caprock's, priced from its model table.",
			Schema: obj(map[string]any{
				"repo":      str(repoDesc),
				"all_repos": boolArg("Every repository, with a total per repository."),
				"days":      intArg("Days back, today included (default 7, at most 90).", maxCostDays),
			}),
			Call: t.cost,
		},
		{
			Name:  "ci_status",
			Title: "CI status",
			Description: "GitHub Actions for a repository: the newest run of each workflow on its default branch, and the checks of the newest session's open pull request, with the failing jobs named. " +
				"Needs GitHub connected in Caprock's Settings; read through Caprock, which already holds that connection.",
			Schema:    obj(map[string]any{"repo": str(repoDesc)}),
			OpenWorld: true,
			Call:      t.ciStatus,
		},
		{
			Name:        "loop_alerts",
			Title:       "Loop alerts",
			Description: "Running sessions that are repeating the same tool call — a likely loop — with the tool, how many times, the repeated input and what the repeats paid to re-read the conversation.",
			Schema:      obj(map[string]any{}),
			Call:        t.loopAlerts,
		},
	}
}

// --- arguments ---

func decode(args json.RawMessage, v any) error {
	if err := json.Unmarshal(args, v); err != nil {
		return fmt.Errorf("bad arguments: %w", err)
	}
	return nil
}

func clampLimit(n, def, hi int) int {
	if n <= 0 {
		return def
	}
	if n > hi {
		return hi
	}
	return n
}

// repoOf is the repository a directory belongs to: its root (the key the
// session list uses) and its project name (the key Second Brain and the daily
// totals use). Outside a repository the directory itself stands for it.
func (t *tools) repoOf(dir string) (root, project string, err error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		dir = t.cwd
	}
	if dir == "" {
		return "", "", errors.New("no repository: pass repo, a directory inside it")
	}
	if !filepath.IsAbs(dir) && t.cwd != "" {
		dir = filepath.Join(t.cwd, dir)
	}
	info := store.RepoFromCwd(dir)
	root, project = info.Root, info.Repo
	if root == "" {
		root = store.NormalizeDir(dir)
	}
	if project == "" {
		project = filepath.Base(filepath.Clean(dir))
	}
	return root, project, nil
}

func when(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).Format(time.RFC3339)
}

func round2(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }

// --- Second Brain ---

type brainNode struct {
	ID      int64  `json:"id"`
	Kind    string `json:"kind"`
	Title   string `json:"title"`
	Summary string `json:"summary"`
	Source  struct {
		SessionID string `json:"session_id"`
		Project   string `json:"project"`
	} `json:"source"`
	Pinned       bool     `json:"pinned"`
	CreatedAt    int64    `json:"created_at"`
	Degree       int      `json:"degree"`
	Keywords     []string `json:"keywords"`
	SupersededBy int64    `json:"superseded_by"`
}

type brainGraph struct {
	Nodes []brainNode `json:"nodes"`
	Edges []struct {
		From int64 `json:"from"`
		To   int64 `json:"to"`
	} `json:"edges"`
	Total int `json:"total"`
}

type memoryOut struct {
	ID        int64    `json:"id"`
	Kind      string   `json:"kind"`
	Title     string   `json:"title"`
	Summary   string   `json:"summary,omitempty"`
	Project   string   `json:"project,omitempty"`
	SessionID string   `json:"session_id,omitempty"`
	Pinned    bool     `json:"pinned,omitempty"`
	CreatedAt string   `json:"created_at,omitempty"`
	Topics    []string `json:"topics,omitempty"`
	Keywords  []string `json:"keywords,omitempty"`
	// SupersededBy names the memory that replaces this one: it is no
	// longer current.
	SupersededBy int64 `json:"superseded_by,omitempty"`
}

func isEntity(kind string) bool { return kind == "topic" || kind == "person" || kind == "project" }

func memoryOf(n brainNode) memoryOut {
	return memoryOut{
		ID: n.ID, Kind: n.Kind, Title: n.Title, Summary: clipRunes(n.Summary, summaryRunes),
		Project: n.Source.Project, SessionID: n.Source.SessionID, Pinned: n.Pinned, CreatedAt: when(n.CreatedAt),
		Keywords: n.Keywords, SupersededBy: n.SupersededBy,
	}
}

func (t *tools) searchMemories(ctx context.Context, args json.RawMessage) (any, error) {
	var a struct {
		Query   string `json:"query"`
		Project string `json:"project"`
		Limit   int    `json:"limit"`
	}
	if err := decode(args, &a); err != nil {
		return nil, err
	}
	q := url.Values{"summaries": {"1"}, "limit": {strconv.Itoa(clampLimit(a.Limit, memoryCandidates, maxLimit))}}
	if s := strings.TrimSpace(a.Query); s != "" {
		q.Set("q", s)
	}
	if s := strings.TrimSpace(a.Project); s != "" {
		q.Set("project", s)
	}
	var g brainGraph
	if err := t.c.get(ctx, "/v1/brain", q, &g); err != nil {
		return nil, err
	}
	byID := map[int64]brainNode{}
	for _, n := range g.Nodes {
		byID[n.ID] = n
	}
	topics := map[int64][]string{}
	for _, e := range g.Edges {
		for _, p := range [][2]int64{{e.From, e.To}, {e.To, e.From}} {
			m, ok1 := byID[p[0]]
			o, ok2 := byID[p[1]]
			if ok1 && ok2 && !isEntity(m.Kind) && o.Kind == "topic" {
				topics[m.ID] = append(topics[m.ID], o.Title)
			}
		}
	}
	out := []memoryOut{}
	for _, n := range g.Nodes {
		if isEntity(n.Kind) {
			continue
		}
		m := memoryOf(n)
		m.Summary = clipRunes(n.Summary, candidateRunes)
		m.Topics = topics[n.ID]
		out = append(out, m)
	}
	res := map[string]any{"total": g.Total, "returned": len(out), "memories": out}
	if strings.TrimSpace(a.Query) != "" && len(out) == 0 {
		res["hint"] = "No memory matched. Rephrase and search again: other or fewer words, a synonym, the component's name, or words in the user's language."
	}
	return res, nil
}

func (t *tools) currentDecisions(ctx context.Context, args json.RawMessage) (any, error) {
	var a struct {
		Project string `json:"project"`
		Limit   int    `json:"limit"`
	}
	if err := decode(args, &a); err != nil {
		return nil, err
	}
	project := strings.TrimSpace(a.Project)
	if project == "" {
		_, p, err := t.repoOf("")
		if err != nil {
			return nil, err
		}
		project = p
	}
	var v struct {
		Decisions []brainNode `json:"decisions"`
	}
	q := url.Values{"project": {project}, "limit": {strconv.Itoa(clampLimit(a.Limit, 50, maxDecisions))}}
	if err := t.c.get(ctx, "/v1/brain/decisions", q, &v); err != nil {
		return nil, err
	}
	out := make([]memoryOut, 0, len(v.Decisions))
	for _, n := range v.Decisions {
		m := memoryOf(n)
		m.Summary = clipRunes(n.Summary, candidateRunes)
		out = append(out, m)
	}
	return map[string]any{"project": project, "decisions": out}, nil
}

func (t *tools) getMemory(ctx context.Context, args json.RawMessage) (any, error) {
	var a struct {
		ID int64 `json:"id"`
	}
	if err := decode(args, &a); err != nil {
		return nil, err
	}
	if a.ID <= 0 {
		return nil, errors.New("id is a memory's id, from search_memories")
	}
	var r struct {
		Node  brainNode `json:"node"`
		Links []struct {
			Node brainNode `json:"node"`
			Kind string    `json:"kind"`
			Out  bool      `json:"out"`
		} `json:"links"`
	}
	if err := t.c.get(ctx, "/v1/brain/nodes/"+strconv.FormatInt(a.ID, 10), nil, &r); err != nil {
		return nil, err
	}
	type link struct {
		Relation string `json:"relation"`
		ID       int64  `json:"id"`
		Kind     string `json:"kind"`
		Title    string `json:"title"`
	}
	m := memoryOf(r.Node)
	m.Summary = clipRunes(r.Node.Summary, noteRunes)
	links := []link{}
	for _, l := range r.Links {
		if len(links) == maxLinks {
			break
		}
		rel := l.Kind
		if !l.Out {
			rel += " (from)"
		}
		links = append(links, link{Relation: rel, ID: l.Node.ID, Kind: l.Node.Kind, Title: l.Node.Title})
	}
	return map[string]any{"memory": m, "links": links}, nil
}

func (t *tools) memoryTopics(ctx context.Context, args json.RawMessage) (any, error) {
	var a struct {
		Project string `json:"project"`
	}
	if err := decode(args, &a); err != nil {
		return nil, err
	}
	q := url.Values{}
	if s := strings.TrimSpace(a.Project); s != "" {
		q.Set("project", s)
	}
	var g brainGraph
	if err := t.c.get(ctx, "/v1/brain", q, &g); err != nil {
		return nil, err
	}
	type topic struct {
		Title    string `json:"title"`
		Memories int    `json:"memories"`
	}
	ts := []topic{}
	for _, n := range g.Nodes {
		if n.Kind == "topic" && n.Degree > 0 {
			ts = append(ts, topic{n.Title, n.Degree})
		}
	}
	sort.SliceStable(ts, func(i, j int) bool { return ts[i].Memories > ts[j].Memories })
	if len(ts) > maxTopics {
		ts = ts[:maxTopics]
	}
	var st struct {
		Memories int `json:"memories"`
		Projects []struct {
			Project string `json:"project"`
			Count   int    `json:"count"`
		} `json:"projects"`
	}
	if err := t.c.get(ctx, "/v1/brain/status", nil, &st); err != nil {
		return nil, err
	}
	// A project filter narrows the count and the project list too: the
	// global total beside one project's topics reads as that project's.
	if p := q.Get("project"); p != "" {
		st.Memories = 0
		mine := st.Projects[:0]
		for _, x := range st.Projects {
			if x.Project == p {
				st.Memories = x.Count
				mine = append(mine, x)
			}
		}
		st.Projects = mine
	}
	if len(st.Projects) > maxTopics {
		st.Projects = st.Projects[:maxTopics]
	}
	return map[string]any{"memories": st.Memories, "topics": ts, "projects": st.Projects}, nil
}

func (t *tools) handoff(ctx context.Context, args json.RawMessage) (any, error) {
	var a struct {
		Repo string `json:"repo"`
	}
	if err := decode(args, &a); err != nil {
		return nil, err
	}
	_, project, err := t.repoOf(a.Repo)
	if err != nil {
		return nil, err
	}
	var v struct {
		Project   string      `json:"project"`
		Decisions []brainNode `json:"decisions"`
		Memories  []brainNode `json:"memories"`
		Max       int         `json:"max"`
		Served    *struct {
			On         bool  `json:"on"`
			LeftOffAt  int64 `json:"left_off_at"`
			HoldoutPct int   `json:"holdout_pct"`
		} `json:"served"`
	}
	if err := t.c.get(ctx, "/v1/brain/handoff", url.Values{"project": {project}}, &v); err != nil {
		return nil, err
	}
	decs := make([]memoryOut, 0, len(v.Decisions))
	for _, n := range v.Decisions {
		decs = append(decs, memoryOf(n))
	}
	mems := make([]memoryOut, 0, len(v.Memories))
	for _, n := range v.Memories {
		mems = append(mems, memoryOf(n))
	}
	out := map[string]any{"project": project, "current_decisions": decs, "memories": mems, "max_memories": v.Max}
	if v.Served != nil {
		out["handoff_on"] = v.Served.On
		out["left_off_at"] = when(v.Served.LeftOffAt)
		out["holdout_pct"] = v.Served.HoldoutPct
		switch {
		case !v.Served.On:
			out["note"] = "Memory between sessions is off in Caprock's Settings: a new session is handed nothing."
		case v.Served.LeftOffAt == 0:
			out["note"] = "No recent passage to quote; a new session gets the current decisions and memories alone."
		default:
			out["note"] = "A new session gets the last passage a session here wrote (see session_prose on the newest session), then the current decisions, then these memories."
		}
	}
	return out, nil
}

// --- sessions ---

type sessionIn struct {
	SessionID   string `json:"session_id"`
	Cwd         string `json:"cwd"`
	Project     string `json:"project"`
	Model       string `json:"model"`
	StartedAt   int64  `json:"started_at"`
	LastEventAt int64  `json:"last_event_at"`
	Status      string `json:"status"`
	GitBranch   string `json:"git_branch"`
	Agent       string `json:"agent"`
	Title       string `json:"title"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Stats       struct {
		Turns        int64   `json:"turns"`
		ToolCalls    int64   `json:"tool_calls"`
		FilesTouched int64   `json:"files_touched"`
		TokensIn     int64   `json:"tokens_in"`
		TokensOut    int64   `json:"tokens_out"`
		CacheRead    int64   `json:"cache_read"`
		CacheWrite   int64   `json:"cache_write"`
		CostUSD      float64 `json:"cost_usd"`
	} `json:"stats"`
	Activity struct {
		Phrase string `json:"phrase"`
		Health string `json:"health"`
	} `json:"activity"`
	Loop *loopIn `json:"loop"`
}

type loopIn struct {
	Tool      string    `json:"tool"`
	Count     int       `json:"count"`
	WindowMin int       `json:"window_min"`
	Sample    string    `json:"sample"`
	FirstTs   time.Time `json:"first_ts"`
	LastTs    time.Time `json:"last_ts"`
	TaxUSD    float64   `json:"tax_usd"`
}

type loopOut struct {
	Tool       string  `json:"tool"`
	Count      int     `json:"count"`
	WindowMin  int     `json:"window_min"`
	Sample     string  `json:"sample,omitempty"`
	Since      string  `json:"since,omitempty"`
	Last       string  `json:"last,omitempty"`
	RereadsUSD float64 `json:"reread_tax_usd,omitempty"`
}

type sessionOut struct {
	ID          string   `json:"id"`
	Agent       string   `json:"agent,omitempty"`
	Title       string   `json:"title,omitempty"`
	Description string   `json:"description,omitempty"`
	Status      string   `json:"status"`
	Project     string   `json:"project,omitempty"`
	Cwd         string   `json:"cwd,omitempty"`
	Branch      string   `json:"branch,omitempty"`
	Model       string   `json:"model,omitempty"`
	StartedAt   string   `json:"started_at,omitempty"`
	LastEventAt string   `json:"last_event_at,omitempty"`
	Doing       string   `json:"doing,omitempty"`
	CostUSD     float64  `json:"cost_usd"`
	Tokens      int64    `json:"tokens"`
	Turns       int64    `json:"turns"`
	ToolCalls   int64    `json:"tool_calls"`
	Files       int64    `json:"files_touched"`
	Loop        *loopOut `json:"loop,omitempty"`
}

func loopOf(l *loopIn) *loopOut {
	if l == nil {
		return nil
	}
	o := &loopOut{Tool: l.Tool, Count: l.Count, WindowMin: l.WindowMin, Sample: clipRunes(l.Sample, sampleRunes), RereadsUSD: round2(l.TaxUSD)}
	if !l.FirstTs.IsZero() {
		o.Since = l.FirstTs.Format(time.RFC3339)
	}
	if !l.LastTs.IsZero() {
		o.Last = l.LastTs.Format(time.RFC3339)
	}
	return o
}

func sessionOf(s sessionIn) sessionOut {
	title := s.Name
	if title == "" {
		title = s.Title
	}
	return sessionOut{
		ID: s.SessionID, Agent: s.Agent, Title: clipRunes(title, 200), Description: clipRunes(s.Description, summaryRunes),
		Status: s.Status, Project: s.Project, Cwd: s.Cwd, Branch: s.GitBranch, Model: s.Model,
		StartedAt: when(s.StartedAt), LastEventAt: when(s.LastEventAt), Doing: clipRunes(s.Activity.Phrase, 200),
		CostUSD: round2(s.Stats.CostUSD), Tokens: s.Stats.TokensIn + s.Stats.TokensOut + s.Stats.CacheRead + s.Stats.CacheWrite,
		Turns: s.Stats.Turns, ToolCalls: s.Stats.ToolCalls, Files: s.Stats.FilesTouched, Loop: loopOf(s.Loop),
	}
}

func (t *tools) recentSessions(ctx context.Context, args json.RawMessage) (any, error) {
	var a struct {
		Repo     string `json:"repo"`
		AllRepos bool   `json:"all_repos"`
		Limit    int    `json:"limit"`
	}
	if err := decode(args, &a); err != nil {
		return nil, err
	}
	n := clampLimit(a.Limit, defaultLimit, maxLimit)
	q := url.Values{"limit": {strconv.Itoa(n)}}
	out := map[string]any{}
	if a.AllRepos {
		q.Set("chats", "exclude")
	} else {
		root, project, err := t.repoOf(a.Repo)
		if err != nil {
			return nil, err
		}
		q.Set("dir", root)
		out["repo"], out["project"] = root, project
	}
	var list []sessionIn
	if err := t.c.get(ctx, "/v1/sessions", q, &list); err != nil {
		return nil, err
	}
	rows := make([]sessionOut, 0, len(list))
	for _, s := range list {
		rows = append(rows, sessionOf(s))
	}
	out["sessions"] = rows
	return out, nil
}

func sessionPath(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" || strings.ContainsAny(id, "/\\?#") || id == "." || id == ".." {
		return "", errors.New("session_id is a session's id, from recent_sessions")
	}
	return "/v1/sessions/" + url.PathEscape(id), nil
}

func (t *tools) sessionSummary(ctx context.Context, args json.RawMessage) (any, error) {
	var a struct {
		SessionID string `json:"session_id"`
	}
	if err := decode(args, &a); err != nil {
		return nil, err
	}
	p, err := sessionPath(a.SessionID)
	if err != nil {
		return nil, err
	}
	var d struct {
		sessionIn
		Files []string `json:"files"`
		PRs   []struct {
			URL    string `json:"url"`
			Number int    `json:"number"`
			Title  string `json:"title"`
		} `json:"prs"`
	}
	if err := t.c.get(ctx, p, nil, &d); err != nil {
		return nil, err
	}
	// The daemon lists the most recently touched paths first and stops at
	// 100; the session's own count says how many there were in all, so a
	// long session's thousands of paths become the latest few and a number.
	files := d.Files
	if len(files) > maxFiles {
		files = files[:maxFiles]
	}
	more := max(int(d.Stats.FilesTouched), len(d.Files)) - len(files)
	type pr struct {
		Number int    `json:"number"`
		Title  string `json:"title,omitempty"`
		URL    string `json:"url"`
	}
	prs := []pr{}
	for _, x := range d.PRs {
		prs = append(prs, pr{x.Number, clipRunes(x.Title, 200), x.URL})
	}
	out := map[string]any{"session": sessionOf(d.sessionIn), "files": files, "pull_requests": prs}
	if more > 0 {
		out["files_not_shown"] = more
		out["files_note"] = fmt.Sprintf("The %d most recently touched files; +%d more.", len(files), more)
	}
	return out, nil
}

type noteIn struct {
	EventID   int64  `json:"event_id"`
	SessionID string `json:"session_id"`
	Project   string `json:"project"`
	Ts        int64  `json:"ts"`
	Text      string `json:"text"`
	Fragment  bool   `json:"fragment"`
}

type noteOut struct {
	SessionID string `json:"session_id"`
	Project   string `json:"project,omitempty"`
	At        string `json:"at"`
	Text      string `json:"text"`
	Fragment  bool   `json:"fragment,omitempty"`
}

func notesOf(in []noteIn) []noteOut {
	out := make([]noteOut, 0, len(in))
	for _, n := range in {
		out = append(out, noteOut{SessionID: n.SessionID, Project: n.Project, At: when(n.Ts), Text: clipRunes(n.Text, noteRunes), Fragment: n.Fragment})
	}
	return out
}

func (t *tools) sessionProse(ctx context.Context, args json.RawMessage) (any, error) {
	var a struct {
		SessionID string `json:"session_id"`
		Limit     int    `json:"limit"`
	}
	if err := decode(args, &a); err != nil {
		return nil, err
	}
	p, err := sessionPath(a.SessionID)
	if err != nil {
		return nil, err
	}
	var notes []noteIn
	if err := t.c.get(ctx, p+"/notes", url.Values{"limit": {strconv.Itoa(clampLimit(a.Limit, 5, 20))}}, &notes); err != nil {
		return nil, err
	}
	return map[string]any{"session_id": strings.TrimSpace(a.SessionID), "notes": notesOf(notes)}, nil
}

func (t *tools) searchProse(ctx context.Context, args json.RawMessage) (any, error) {
	var a struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := decode(args, &a); err != nil {
		return nil, err
	}
	if strings.TrimSpace(a.Query) == "" {
		return nil, errors.New("query is required")
	}
	var notes []noteIn
	q := url.Values{"q": {strings.TrimSpace(a.Query)}, "limit": {strconv.Itoa(clampLimit(a.Limit, defaultLimit, maxLimit))}}
	if err := t.c.get(ctx, "/v1/notes", q, &notes); err != nil {
		return nil, err
	}
	return map[string]any{"notes": notesOf(notes)}, nil
}

// --- cost ---

func (t *tools) cost(ctx context.Context, args json.RawMessage) (any, error) {
	var a struct {
		Repo     string `json:"repo"`
		AllRepos bool   `json:"all_repos"`
		Days     int    `json:"days"`
	}
	if err := decode(args, &a); err != nil {
		return nil, err
	}
	days := clampLimit(a.Days, 7, maxCostDays)
	project := ""
	if !a.AllRepos {
		var err error
		if _, project, err = t.repoOf(a.Repo); err != nil {
			return nil, err
		}
	}
	var rows []struct {
		Day         string  `json:"day"`
		Project     string  `json:"project"`
		Model       string  `json:"model"`
		TokensTotal int64   `json:"tokens_total"`
		CostUSD     float64 `json:"cost_usd"`
	}
	if err := t.c.get(ctx, "/v1/stats/daily", url.Values{"days": {strconv.Itoa(days)}}, &rows); err != nil {
		return nil, err
	}
	type sum struct {
		CostUSD float64 `json:"cost_usd"`
		Tokens  int64   `json:"tokens"`
	}
	byDay, byModel, byProject := map[string]*sum{}, map[string]*sum{}, map[string]*sum{}
	var total sum
	add := func(m map[string]*sum, k string, usd float64, tok int64) {
		if m[k] == nil {
			m[k] = &sum{}
		}
		m[k].CostUSD += usd
		m[k].Tokens += tok
	}
	for _, r := range rows {
		if project != "" && r.Project != project {
			continue
		}
		model := r.Model
		if model == "" {
			model = "(unknown)"
		}
		add(byDay, r.Day, r.CostUSD, r.TokensTotal)
		add(byModel, model, r.CostUSD, r.TokensTotal)
		add(byProject, r.Project, r.CostUSD, r.TokensTotal)
		total.CostUSD += r.CostUSD
		total.Tokens += r.TokensTotal
	}
	flat := func(m map[string]*sum, name string, byCost bool, maxN int) []map[string]any {
		ks := make([]string, 0, len(m))
		for k := range m {
			ks = append(ks, k)
		}
		sort.Slice(ks, func(i, j int) bool {
			if byCost {
				return m[ks[i]].CostUSD > m[ks[j]].CostUSD
			}
			return ks[i] < ks[j]
		})
		if maxN > 0 && len(ks) > maxN {
			ks = ks[:maxN]
		}
		out := make([]map[string]any, 0, len(ks))
		for _, k := range ks {
			out = append(out, map[string]any{name: k, "cost_usd": round2(m[k].CostUSD), "tokens": m[k].Tokens})
		}
		return out
	}
	out := map[string]any{
		"days":     days,
		"total":    map[string]any{"cost_usd": round2(total.CostUSD), "tokens": total.Tokens},
		"by_day":   flat(byDay, "day", false, 0),
		"by_model": flat(byModel, "model", true, 20),
		"note":     "Priced by Caprock at API list rates; on a flat plan (Pro, Max) this is what the same usage would cost on the API, not what was billed.",
	}
	if a.AllRepos {
		out["by_project"] = flat(byProject, "project", true, 30)
	} else {
		out["project"] = project
	}
	return out, nil
}

// --- CI ---

type ciIn struct {
	Repo    string `json:"repo"`
	Branch  string `json:"branch"`
	HeadSHA string `json:"head_sha"`
	State   string `json:"state"`
	Runs    []struct {
		Name       string `json:"name"`
		Event      string `json:"event"`
		Status     string `json:"status"`
		Conclusion string `json:"conclusion"`
		HTMLURL    string `json:"html_url"`
		UpdatedAt  int64  `json:"updated_at"`
		HeadBranch string `json:"head_branch"`
		HeadSHA    string `json:"head_sha"`
		Jobs       []struct {
			Name       string `json:"name"`
			Status     string `json:"status"`
			Conclusion string `json:"conclusion"`
			HTMLURL    string `json:"html_url"`
			Steps      []struct {
				Name       string `json:"name"`
				Conclusion string `json:"conclusion"`
			} `json:"steps"`
		} `json:"jobs"`
	} `json:"runs"`
}

type ghErr struct {
	Kind    string `json:"kind"`
	Doing   string `json:"doing"`
	Message string `json:"message"`
}

func (e *ghErr) text() string {
	if e == nil {
		return ""
	}
	return strings.TrimSpace(strings.TrimSpace(e.Doing+": ") + " " + e.Message)
}

func failed(c string) bool {
	return c == "failure" || c == "timed_out" || c == "startup_failure" || c == "action_required"
}

func shortSHA(s string) string {
	if len(s) > 10 {
		return s[:10]
	}
	return s
}

func ciOf(c *ciIn) map[string]any {
	if c == nil {
		return nil
	}
	type job struct {
		Name       string `json:"name"`
		Conclusion string `json:"conclusion"`
		FailedStep string `json:"failed_step,omitempty"`
		URL        string `json:"url,omitempty"`
	}
	type run struct {
		Workflow   string `json:"workflow"`
		Status     string `json:"status"`
		Conclusion string `json:"conclusion,omitempty"`
		Branch     string `json:"branch,omitempty"`
		Commit     string `json:"commit,omitempty"`
		Event      string `json:"event,omitempty"`
		UpdatedAt  string `json:"updated_at,omitempty"`
		URL        string `json:"url,omitempty"`
		FailedJobs []job  `json:"failed_jobs,omitempty"`
	}
	runs := []run{}
	for i, r := range c.Runs {
		if i == maxCIRuns {
			break
		}
		o := run{Workflow: r.Name, Status: r.Status, Conclusion: r.Conclusion, Branch: r.HeadBranch, Commit: shortSHA(r.HeadSHA), Event: r.Event, UpdatedAt: when(r.UpdatedAt), URL: r.HTMLURL}
		for _, j := range r.Jobs {
			if !failed(j.Conclusion) || len(o.FailedJobs) == maxFailedJobs {
				continue
			}
			fj := job{Name: j.Name, Conclusion: j.Conclusion, URL: j.HTMLURL}
			for _, s := range j.Steps {
				if failed(s.Conclusion) {
					fj.FailedStep = s.Name
					break
				}
			}
			o.FailedJobs = append(o.FailedJobs, fj)
		}
		runs = append(runs, o)
	}
	return map[string]any{"state": c.State, "commit": shortSHA(c.HeadSHA), "runs": runs}
}

func (t *tools) ciStatus(ctx context.Context, args json.RawMessage) (any, error) {
	var a struct {
		Repo string `json:"repo"`
	}
	if err := decode(args, &a); err != nil {
		return nil, err
	}
	root, project, err := t.repoOf(a.Repo)
	if err != nil {
		return nil, err
	}
	// The CI views are a session's (its directory's remote, its pull
	// request): the repository's newest session stands for it.
	var list []sessionIn
	if err := t.c.get(ctx, "/v1/sessions", url.Values{"dir": {root}, "limit": {"1"}}, &list); err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, fmt.Errorf("caprock has recorded no session in %s, so it does not know this repository's GitHub remote yet", root)
	}
	sp, err := sessionPath(list[0].SessionID)
	if err != nil {
		return nil, err
	}
	var main struct {
		Connected bool   `json:"connected"`
		Repo      string `json:"repo"`
		Reason    string `json:"reason"`
		Branch    string `json:"branch"`
		CI        *ciIn  `json:"ci"`
		Error     *ghErr `json:"error"`
	}
	if err := t.c.get(ctx, sp+"/ci/main", nil, &main); err != nil {
		return nil, err
	}
	out := map[string]any{"project": project, "repo": main.Repo}
	switch main.Reason {
	case "no_repo":
		return nil, fmt.Errorf("%s has no git remote Caprock can read", root)
	case "not_github":
		return nil, fmt.Errorf("%s's remote is not on github.com; Caprock reads CI from GitHub Actions only", root)
	}
	if !main.Connected {
		out["github_connected"] = false
		out["note"] = "GitHub is not connected in Caprock (Settings → GitHub), so no CI is read."
		return out, nil
	}
	out["github_connected"] = true
	def := map[string]any{"branch": main.Branch}
	if main.Error != nil {
		def["error"] = main.Error.text()
	}
	if c := ciOf(main.CI); c != nil {
		for k, v := range c {
			def[k] = v
		}
	}
	out["default_branch"] = def
	var pr struct {
		PR *struct {
			Number int    `json:"number"`
			URL    string `json:"url"`
			Title  string `json:"title"`
			State  string `json:"state"`
		} `json:"pr"`
		CI    *ciIn  `json:"ci"`
		Error *ghErr `json:"error"`
	}
	if err := t.c.get(ctx, sp+"/ci", nil, &pr); err == nil && pr.PR != nil {
		p := map[string]any{"number": pr.PR.Number, "title": clipRunes(pr.PR.Title, 200), "url": pr.PR.URL, "state": pr.PR.State, "session_id": list[0].SessionID}
		if pr.Error != nil {
			p["error"] = pr.Error.text()
		}
		if c := ciOf(pr.CI); c != nil {
			p["checks"] = c
		}
		out["pull_request"] = p
	}
	return out, nil
}

// --- loops ---

func (t *tools) loopAlerts(ctx context.Context, _ json.RawMessage) (any, error) {
	var list []sessionIn
	if err := t.c.get(ctx, "/v1/sessions", url.Values{"active": {"true"}, "limit": {"500"}}, &list); err != nil {
		return nil, err
	}
	type alert struct {
		SessionID string   `json:"session_id"`
		Title     string   `json:"title,omitempty"`
		Project   string   `json:"project,omitempty"`
		Cwd       string   `json:"cwd,omitempty"`
		Loop      *loopOut `json:"loop"`
	}
	out := []alert{}
	for _, s := range list {
		if s.Loop == nil {
			continue
		}
		o := sessionOf(s)
		out = append(out, alert{SessionID: o.ID, Title: o.Title, Project: o.Project, Cwd: o.Cwd, Loop: o.Loop})
	}
	res := map[string]any{"alerts": out, "running_sessions": len(list)}
	if len(out) == 0 {
		res["note"] = "No running session is repeating a tool call."
	}
	return res, nil
}
