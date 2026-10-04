package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/loop"
)

// The Week: what this machine's agents did over seven days, for a card someone
// can share. Every figure is read from events already stored; nothing here
// calls GitHub or anything else off the machine (rule 4), which bounds what can
// be said -- "merged" is a merge the agents ran, not GitHub's state.
//
// Privacy is part of the shape, not of the screen: nothing returned names a
// repository, a path, a prompt or a session title, so no caller can leak one by
// rendering a field it should not have.

// WeekOptions say which seven days, and how the product detects a loop.
type WeekOptions struct {
	// From and To bound the window, [From, To). The caller computes them from
	// local midnights, the same days the Cost screen uses.
	From, To time.Time
	// Loc decides which day an event falls on.
	Loc *time.Location
	// LoopK and LoopWindow are the loop detector's own settings (K calls of
	// one signature within the window), so the card's loop is the alert's loop.
	LoopK      int
	LoopWindow time.Duration
	// Home is the user's home directory: notes an agent writes under
	// ~/.claude are memory, not code, and are not counted as files edited.
	Home string
	// TempDirs are scratch locations whose files are not counted either.
	TempDirs []string
}

// Week is the measured week. Estimates are named as such in their comments and
// in the API's `estimates` list; everything else is a count or a sum.
type Week struct {
	FromMs int64 `json:"from_ms"`
	ToMs   int64 `json:"to_ms"`
	// Days are the seven days in order, each with what it opened and cost.
	Days []WeekDay `json:"days"`
	// Sessions is every session with a non-internal event in the window.
	Sessions   int64 `json:"sessions"`
	ActiveDays int   `json:"active_days"`
	Turns      int64 `json:"turns"`
	// CostUSD is the stored list-price cost of the window's turns: priced once
	// per message id and never twice across forks (TurnPaidElsewhere).
	CostUSD float64 `json:"cost_usd"`
	// UnpricedTurns carry tokens and no price, so CostUSD leaves them out.
	UnpricedTurns int64 `json:"unpriced_turns,omitempty"`
	// Models is each model's cost and re-read volume, for the context tax.
	Models []WeekModel `json:"models"`

	PRsOpened int `json:"prs_opened"`
	// PRsMerged is distinct pull requests a successful `gh pr merge` named,
	// by URL, by number, or -- for the current-branch form -- by the one URL
	// the command printed. MergesUnresolved ran but named nothing readable and
	// are not in PRsMerged.
	PRsMerged        int   `json:"prs_merged"`
	MergesUnresolved int   `json:"merges_unresolved"`
	Commits          int   `json:"commits"`
	FilesEdited      int   `json:"files_edited"`
	LinesAdded       int64 `json:"lines_added"`   // estimate: a Write counts its whole file
	LinesRemoved     int64 `json:"lines_removed"` // estimate: as above
	// CIWaitMs is tool time spent in commands that wait on CI; ToolMs is all
	// measured tool time. Only Claude Code's hook plane carries a duration, and
	// parallel calls overlap, so neither is wall-clock time.
	CIWaitMs int64 `json:"ci_wait_ms"`
	ToolMs   int64 `json:"tool_ms"`

	Agents  []WeekAgent  `json:"agents"`
	Loop    *WeekLoop    `json:"loop,omitempty"`
	Biggest *WeekSession `json:"biggest,omitempty"`
}

// WeekDay is one local day of the window.
type WeekDay struct {
	Day       string  `json:"day"`
	PRsOpened int     `json:"prs_opened"`
	CostUSD   float64 `json:"cost_usd"`
	Active    bool    `json:"active"`
}

// WeekModel is one model's share of the week, the input to the context tax.
type WeekModel struct {
	Model     string  `json:"model"`
	CacheRead int64   `json:"cache_read"`
	CostUSD   float64 `json:"cost_usd"`
}

// WeekAgent is one agent's main threads, or its subagents.
type WeekAgent struct {
	Agent    string  `json:"agent"`
	Subagent bool    `json:"subagent"`
	Turns    int64   `json:"turns"`
	CostUSD  float64 `json:"cost_usd"`
	Sessions int64   `json:"sessions"`
	// Threads is how many distinct subagents ran; 0 for main threads.
	Threads int64 `json:"threads,omitempty"`
}

// WeekLoop is the longest episode the loop detector would have alerted on.
type WeekLoop struct {
	SessionID string `json:"-"` // for pricing; never shown
	Agent     string `json:"agent"`
	Tool      string `json:"tool"`
	// Kind is what the repeated call did, in words a card can use without
	// quoting the command: poll, command, edit, fetch, subagent, other.
	Kind    string `json:"kind"`
	Calls   int    `json:"calls"`
	FirstMs int64  `json:"first_ms"`
	LastMs  int64  `json:"last_ms"`
	// TaxUSD is what the loop paid to re-read the conversation, priced the way
	// the live alert prices it (contexttax.PriceSeries) -- an estimate, and
	// absent when none of its calls could be priced (Codex calls carry no
	// message id). TaxPricedCalls says how many calls it covers.
	TaxUSD         float64 `json:"tax_usd,omitempty"`
	TaxPricedCalls int     `json:"tax_priced_calls,omitempty"`
}

// WeekSession is the week's most expensive session, without its name.
type WeekSession struct {
	SessionID  string  `json:"-"`
	Agent      string  `json:"agent"`
	CostUSD    float64 `json:"cost_usd"`
	Turns      int64   `json:"turns"`
	ActiveDays int     `json:"active_days"`
}

// WeekStats measures one window. See Week for what each figure means.
func WeekStats(ctx context.Context, q Querier, o WeekOptions) (Week, error) {
	if o.Loc == nil {
		o.Loc = time.Local
	}
	from, to := o.From.UnixMilli(), o.To.UnixMilli()
	w := Week{FromMs: from, ToMs: to, Models: []WeekModel{}, Agents: []WeekAgent{}}
	days := map[string]int{}
	for d := o.From.In(o.Loc); d.Before(o.To); d = time.Date(d.Year(), d.Month(), d.Day()+1, 0, 0, 0, 0, o.Loc) {
		days[d.Format("2006-01-02")] = len(w.Days)
		w.Days = append(w.Days, WeekDay{Day: d.Format("2006-01-02")})
	}
	dayOf := func(ms int64) (int, bool) {
		i, ok := days[time.UnixMilli(ms).In(o.Loc).Format("2006-01-02")]
		return i, ok
	}

	if err := weekActivity(ctx, q, from, to, &w, dayOf); err != nil {
		return w, err
	}
	if err := weekAgents(ctx, q, from, to, &w); err != nil {
		return w, err
	}
	if err := weekModels(ctx, q, from, to, &w); err != nil {
		return w, err
	}
	if err := weekBiggest(ctx, q, from, to, &w, o.Loc); err != nil {
		return w, err
	}
	if err := weekTools(ctx, q, from, to, &w, o, dayOf); err != nil {
		return w, err
	}
	if err := weekLoop(ctx, q, from, to, &w, o); err != nil {
		return w, err
	}
	return w, nil
}

// weekActivity fills the per-day cost, the active days, the session count and
// the total. It reads the same covering index Summarize reads.
func weekActivity(ctx context.Context, q Querier, from, to int64, w *Week, dayOf func(int64) (int, bool)) error {
	rows, err := q.QueryContext(ctx, `
		SELECT ts, kind, cost_usd,
		       COALESCE(tokens_in,0)+COALESCE(tokens_out,0)+COALESCE(cache_read,0)+COALESCE(cache_write,0)
		FROM events INDEXED BY idx_events_ts_cover
		WHERE ts >= ? AND ts < ?`+nonInternalEvent, from, to)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var ts, tokens int64
		var kind string
		var cost sql.NullFloat64
		if err := rows.Scan(&ts, &kind, &cost, &tokens); err != nil {
			return err
		}
		i, ok := dayOf(ts)
		if !ok {
			continue
		}
		w.Days[i].Active = true
		if cost.Valid {
			w.Days[i].CostUSD += cost.Float64
			w.CostUSD += cost.Float64
		}
		if kind == "turn.assistant" {
			w.Turns++
			if !cost.Valid && tokens > 0 {
				w.UnpricedTurns++
			}
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, d := range w.Days {
		if d.Active {
			w.ActiveDays++
		}
	}
	return q.QueryRowContext(ctx,
		`SELECT COUNT(DISTINCT session_id) FROM events INDEXED BY idx_events_ts_cover WHERE ts >= ? AND ts < ?`+nonInternalEvent,
		from, to).Scan(&w.Sessions)
}

// weekAgents splits the turns by agent, and Claude Code's by main thread and
// subagent (store.MainThreadWhere's rule, negated).
func weekAgents(ctx context.Context, q Querier, from, to int64, w *Week) error {
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(s.agent,'claude'),
		       NOT (`+MainThreadWhere+`),
		       COUNT(*), COALESCE(SUM(e.cost_usd),0),
		       COUNT(DISTINCT e.session_id), COUNT(DISTINCT NULLIF(e.agent_id,''))
		FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
		WHERE e.kind = 'turn.assistant' AND e.ts >= ? AND e.ts < ?`+nonInternalEventE+`
		GROUP BY 1, 2`, from, to)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var a WeekAgent
		if err := rows.Scan(&a.Agent, &a.Subagent, &a.Turns, &a.CostUSD, &a.Sessions, &a.Threads); err != nil {
			return err
		}
		if !a.Subagent {
			a.Threads = 0
		}
		w.Agents = append(w.Agents, a)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	sort.SliceStable(w.Agents, func(i, j int) bool { return w.Agents[i].CostUSD > w.Agents[j].CostUSD })
	return nil
}

func weekModels(ctx context.Context, q Querier, from, to int64, w *Week) error {
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(model,''), COALESCE(SUM(cache_read),0), COALESCE(SUM(cost_usd),0)
		FROM events WHERE kind = 'turn.assistant' AND ts >= ? AND ts < ?`+nonInternalEvent+`
		GROUP BY 1 ORDER BY 3 DESC`, from, to)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var m WeekModel
		if err := rows.Scan(&m.Model, &m.CacheRead, &m.CostUSD); err != nil {
			return err
		}
		w.Models = append(w.Models, m)
	}
	return rows.Err()
}

func weekBiggest(ctx context.Context, q Querier, from, to int64, w *Week, loc *time.Location) error {
	var b WeekSession
	err := q.QueryRowContext(ctx, `
		SELECT e.session_id, COALESCE(s.agent,'claude'), COALESCE(SUM(e.cost_usd),0), COUNT(*)
		FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
		WHERE e.kind = 'turn.assistant' AND e.ts >= ? AND e.ts < ?`+nonInternalEventE+`
		GROUP BY e.session_id ORDER BY 3 DESC, 4 DESC LIMIT 1`, from, to).Scan(&b.SessionID, &b.Agent, &b.CostUSD, &b.Turns)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if b.CostUSD <= 0 {
		return nil
	}
	rows, err := q.QueryContext(ctx, `SELECT ts FROM events WHERE session_id = ? AND kind = 'turn.assistant' AND ts >= ? AND ts < ?`+nonInternalEvent, b.SessionID, from, to)
	if err != nil {
		return err
	}
	defer rows.Close()
	seen := map[string]bool{}
	for rows.Next() {
		var ts int64
		if err := rows.Scan(&ts); err != nil {
			return err
		}
		seen[time.UnixMilli(ts).In(loc).Format("2006-01-02")] = true
	}
	b.ActiveDays = len(seen)
	w.Biggest = &b
	return rows.Err()
}

// toolPost is the part of a tool.post payload the week reads. Claude Code's
// hook plane sends tool_input beside a structured tool_response; the
// transcript plane sends the response as text and an is_error flag, and its
// input is on the matching tool.pre.
type toolPost struct {
	HookEvent    string          `json:"hook_event_name"`
	IsError      bool            `json:"is_error"`
	ToolUseID    string          `json:"tool_use_id"`
	Cwd          string          `json:"cwd"`
	DurationMs   int64           `json:"duration_ms"`
	ToolInput    json.RawMessage `json:"tool_input"`
	ToolResponse json.RawMessage `json:"tool_response"`
}

type toolInput struct {
	Command   string `json:"command"`
	FilePath  string `json:"file_path"`
	OldString string `json:"old_string"`
	NewString string `json:"new_string"`
	Content   string `json:"content"`
	Edits     []struct {
		OldString string `json:"old_string"`
		NewString string `json:"new_string"`
	} `json:"edits"`
}

// succeeded reports whether a call finished without failing. A hook-plane
// PostToolUse is sent only for a call that did not fail (failures arrive as
// PostToolUseFailure); an interrupted call is not a success either.
func (p toolPost) succeeded() bool {
	if p.IsError {
		return false
	}
	if p.HookEvent != "" && p.HookEvent != "PostToolUse" {
		return false
	}
	var r struct {
		Interrupted bool `json:"interrupted"`
	}
	if len(p.ToolResponse) > 0 && p.ToolResponse[0] == '{' && json.Unmarshal(p.ToolResponse, &r) == nil && r.Interrupted {
		return false
	}
	return true
}

// output is what the call printed: stdout and stderr, or the transcript's text.
func (p toolPost) output() string {
	if len(p.ToolResponse) == 0 {
		return ""
	}
	switch p.ToolResponse[0] {
	case '"':
		var s string
		_ = json.Unmarshal(p.ToolResponse, &s)
		return s
	case '{':
		var r struct {
			Stdout string `json:"stdout"`
			Stderr string `json:"stderr"`
		}
		_ = json.Unmarshal(p.ToolResponse, &r)
		return r.Stdout + "\n" + r.Stderr
	}
	return ""
}

type bashCall struct {
	ts    int64
	stmts []shellStatement
	out   string
}

// weekTools reads the successful Bash, Edit, Write and MultiEdit calls: pull
// requests, commits, files and lines, and the time spent waiting on CI.
func weekTools(ctx context.Context, q Querier, from, to int64, w *Week, o WeekOptions, dayOf func(int64) (int, bool)) error {
	rows, err := q.QueryContext(ctx, `
		SELECT e.session_id, COALESCE(e.key,''), COALESCE(e.tool,''), e.ts, e.payload
		FROM events e
		WHERE e.kind = 'tool.post' AND e.ts >= ? AND e.ts < ?`+nonInternalEventE+`
		  AND e.tool IN ('Bash','Edit','Write','MultiEdit')
		ORDER BY e.ts, e.id`, from, to)
	if err != nil {
		return err
	}
	type row struct {
		session, key, tool string
		ts                 int64
		p                  toolPost
	}
	var posts []row
	for rows.Next() {
		var r row
		var payload []byte
		if err := rows.Scan(&r.session, &r.key, &r.tool, &r.ts, &payload); err != nil {
			_ = rows.Close()
			return err
		}
		if json.Unmarshal(payload, &r.p) != nil || !r.p.succeeded() {
			continue
		}
		posts = append(posts, r)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	_ = rows.Close()

	var bash []bashCall
	files := map[string]bool{}
	for _, r := range posts {
		in := r.p.ToolInput
		if len(in) == 0 || string(in) == "null" {
			// The transcript plane keeps the input on the call's tool.pre.
			in, err = preInput(ctx, q, r.session, r.key)
			if err != nil {
				return err
			}
		}
		var ti toolInput
		if json.Unmarshal(in, &ti) != nil {
			continue
		}
		switch r.tool {
		case "Bash":
			if ti.Command == "" {
				continue
			}
			c := bashCall{ts: r.ts, stmts: splitShell(ti.Command, r.p.Cwd), out: r.p.output()}
			bash = append(bash, c)
			if r.p.DurationMs > 0 {
				w.ToolMs += r.p.DurationMs
				if waitsOnCI(c.stmts) {
					w.CIWaitMs += r.p.DurationMs
				}
			}
		default:
			if r.p.DurationMs > 0 {
				w.ToolMs += r.p.DurationMs
			}
			if ti.FilePath == "" || !countableFile(ti.FilePath, o) {
				continue
			}
			files[filepath.Clean(ti.FilePath)] = true
			switch r.tool {
			case "Edit":
				w.LinesAdded += lineCount(ti.NewString)
				w.LinesRemoved += lineCount(ti.OldString)
			case "Write":
				w.LinesAdded += lineCount(ti.Content)
			case "MultiEdit":
				for _, e := range ti.Edits {
					w.LinesAdded += lineCount(e.NewString)
					w.LinesRemoved += lineCount(e.OldString)
				}
			}
		}
	}
	w.FilesEdited = len(files)
	countPRs(bash, w, dayOf)
	return nil
}

func preInput(ctx context.Context, q Querier, session, postKey string) (json.RawMessage, error) {
	id, ok := strings.CutPrefix(postKey, "post:")
	if !ok {
		return nil, nil
	}
	var payload []byte
	err := q.QueryRowContext(ctx, `SELECT payload FROM events WHERE session_id = ? AND key = ?`, session, "pre:"+id).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p struct {
		ToolInput json.RawMessage `json:"tool_input"`
	}
	_ = json.Unmarshal(payload, &p)
	return p.ToolInput, nil
}

// countableFile keeps files in the user's work: not scratch files in a temp
// directory, and not the notes an agent keeps under ~/.claude.
func countableFile(path string, o WeekOptions) bool {
	p := filepath.Clean(path)
	skip := append([]string{}, o.TempDirs...)
	if o.Home != "" {
		skip = append(skip, filepath.Join(o.Home, ".claude"))
	}
	for _, d := range skip {
		if d == "" {
			continue
		}
		d = filepath.Clean(d)
		if p == d || strings.HasPrefix(p, d+string(filepath.Separator)) || strings.HasPrefix(p, d+"/") {
			return false
		}
	}
	return true
}

// DefaultTempDirs are the scratch locations on this platform.
func DefaultTempDirs() []string {
	dirs := []string{os.TempDir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"}
	if t, err := filepath.EvalSymlinks(os.TempDir()); err == nil {
		dirs = append(dirs, t)
	}
	return dirs
}

// countPRs counts pull requests opened and merged, and commits, from the Bash
// calls in time order.
//
// A merge by number needs a repository to make it distinct, and the command
// rarely says which. The directory it ran in does: each directory that printed
// a pull-request URL from `gh pr create` is mapped to that URL's owner/repo,
// so "merge 12" there and "merge https://.../pull/12" are the same pull request.
func countPRs(calls []bashCall, w *Week, dayOf func(int64) (int, bool)) {
	slugOfRoot := map[string]string{}
	rootOf := map[string]string{}
	root := func(dir string) string {
		if dir == "" {
			return ""
		}
		if r, ok := rootOf[dir]; ok {
			return r
		}
		r := RepoFromCwd(dir).Root
		if r == "" {
			r = dir
		}
		rootOf[dir] = r
		return r
	}
	opened := map[prRef]bool{}
	for _, c := range calls {
		w.Commits += countCommits(c.stmts, c.out)
		for _, st := range c.stmts {
			if ghPR(st) != "create" {
				continue
			}
			refs := openedPRs(c.out)
			for _, r := range refs {
				if !opened[r] {
					opened[r] = true
					if i, ok := dayOf(c.ts); ok {
						w.Days[i].PRsOpened++
					}
				}
			}
			if len(refs) == 1 {
				slugOfRoot[root(st.dir)] = refs[0].slug
			}
			break
		}
	}
	w.PRsOpened = len(opened)

	merged := map[string]bool{}
	for _, c := range calls {
		for _, st := range c.stmts {
			if ghPR(st) != "merge" {
				continue
			}
			t := parseMerge(st)
			if t.number == 0 {
				// The current-branch form. Resolvable only when the command
				// printed exactly one pull request -- the one it just opened,
				// in practice -- and otherwise not counted at all.
				refs := distinctPRs(c.out)
				if len(refs) != 1 {
					w.MergesUnresolved++
					continue
				}
				t.slug, t.number = refs[0].slug, refs[0].number
			}
			repo := t.slug
			if repo == "" {
				r := root(t.dir)
				if s, ok := slugOfRoot[r]; ok {
					repo = s
				} else {
					repo = "dir:" + r
				}
			}
			merged[repo+"#"+itoa(t.number)] = true
		}
	}
	w.PRsMerged = len(merged)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// weekLoop replays the window's tool calls through the loop detector's own
// rule: the same signature (loop.Signature) at least K times within the
// window, read-only tools skipped. An episode runs while repeats keep arriving
// within the window of each other, as the detector's cooldown does, and the
// longest episode is the week's loop.
//
// Calls issued by a single assistant message are one decision, not a
// repetition: launching eleven subagents in one turn is a panel, not a loop.
// Where the call carries its message id, repeats from the same message count
// once.
func weekLoop(ctx context.Context, q Querier, from, to int64, w *Week, o WeekOptions) error {
	k, win := o.LoopK, o.LoopWindow
	if k <= 0 {
		k = 5
	}
	if win <= 0 {
		win = 3 * time.Minute
	}
	rows, err := q.QueryContext(ctx, `
		SELECT e.session_id, COALESCE(s.agent,'claude'), COALESCE(e.tool,''), e.ts, COALESCE(e.msg_id,''), e.payload
		FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
		WHERE e.kind = 'tool.pre' AND e.ts >= ? AND e.ts < ?`+nonInternalEventE+`
		ORDER BY e.session_id, e.ts, e.id`, from, to)
	if err != nil {
		return err
	}
	defer rows.Close()
	type hit struct {
		ts  int64
		msg string
	}
	type series struct {
		session, agent, tool string
		payload              []byte
		hits                 []hit
	}
	all := map[string]*series{}
	for rows.Next() {
		var sess, agent, tool, msg string
		var ts int64
		var payload []byte
		if err := rows.Scan(&sess, &agent, &tool, &ts, &msg, &payload); err != nil {
			return err
		}
		if tool == "" || loop.ReadOnly(tool) {
			continue
		}
		sig, _ := loop.Signature(tool, payload)
		if sig == "" {
			continue
		}
		key := sess + "\x00" + sig
		s := all[key]
		if s == nil {
			s = &series{session: sess, agent: agent, tool: tool, payload: payload}
			all[key] = s
		}
		s.hits = append(s.hits, hit{ts, msg})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	winMs := win.Milliseconds()
	var best *WeekLoop
	keys := make([]string, 0, len(all))
	for key := range all {
		keys = append(keys, key)
	}
	sort.Strings(keys) // deterministic ties
	for _, key := range keys {
		s := all[key]
		// One hit per message: a turn that issued the same call five times in
		// parallel decided once.
		var hits []hit
		seenMsg := map[string]bool{}
		for _, h := range s.hits {
			if h.msg != "" {
				if seenMsg[h.msg] {
					continue
				}
				seenMsg[h.msg] = true
			}
			hits = append(hits, h)
		}
		for start := 0; start < len(hits); {
			end := start + 1
			for end < len(hits) && hits[end].ts-hits[end-1].ts <= winMs {
				end++
			}
			ep := hits[start:end]
			if len(ep) >= k && maxInWindow(ep, winMs, func(h hit) int64 { return h.ts }) >= k {
				first, last := ep[0].ts, ep[len(ep)-1].ts
				if best == nil || len(ep) > best.Calls || (len(ep) == best.Calls && last-first > best.LastMs-best.FirstMs) {
					best = &WeekLoop{SessionID: s.session, Agent: s.agent, Tool: s.tool, Kind: loopKind(s.tool, s.payload), Calls: len(ep), FirstMs: first, LastMs: last}
				}
			}
			start = end
		}
	}
	w.Loop = best
	return nil
}

func maxInWindow[T any](xs []T, win int64, ts func(T) int64) int {
	best, j := 0, 0
	for i := range xs {
		for ts(xs[i])-ts(xs[j]) > win {
			j++
		}
		if n := i - j + 1; n > best {
			best = n
		}
	}
	return best
}

// loopKind names what a repeated call did, without quoting it.
func loopKind(tool string, payload []byte) string {
	t := strings.ToLower(tool)
	// Codex wraps its tools in a script: `exec` with a command that calls
	// tools.write_stdin({..., chars:""}). An empty write to a running process
	// is a poll: "done yet?".
	if t == "exec" {
		var p struct {
			ToolInput struct {
				Command string `json:"command"`
			} `json:"tool_input"`
		}
		_ = json.Unmarshal(payload, &p)
		c := strings.ReplaceAll(p.ToolInput.Command, " ", "")
		if strings.Contains(c, "write_stdin(") {
			if strings.Contains(c, `chars:""`) || strings.Contains(c, `"chars":""`) {
				return "poll"
			}
			return "input"
		}
		return "command"
	}
	switch {
	case strings.Contains(t, "write_stdin") || strings.Contains(t, "poll"):
		var p struct {
			ToolInput map[string]any `json:"tool_input"`
		}
		_ = json.Unmarshal(payload, &p)
		chars, hasChars := p.ToolInput["chars"].(string)
		if cmd, ok := p.ToolInput["command"].(string); ok && !hasChars {
			var inner map[string]any
			if json.Unmarshal([]byte(cmd), &inner) == nil {
				chars, hasChars = inner["chars"].(string)
			}
		}
		if hasChars && chars == "" {
			return "poll"
		}
		return "input"
	case t == "bash" || t == "shell" || t == "exec_command" || t == "js":
		return "command"
	case t == "edit" || t == "write" || t == "multiedit" || t == "apply_patch":
		return "edit"
	case t == "webfetch" || t == "websearch":
		return "fetch"
	case t == "agent" || t == "task":
		return "subagent"
	}
	return "other"
}
