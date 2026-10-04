package store

import (
	"context"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ToolDrill is what one tool did in a window: its calls grouped by what they
// were about (the command a shell call ran, the file a Read or Edit touched,
// the domain a fetch reached), with what came back and how often it failed.
//
// Every figure is counted from stored events. Nothing is estimated: a call
// whose result was never recorded counts as a call and is left out of the
// failure rate rather than guessed at.
type ToolDrill struct {
	Tool string `json:"tool"`
	// Kind is how the calls are grouped: shell, files, web, mcp or other.
	Kind string `json:"kind"`
	// GroupBy names a row's key in words: command, file, domain, query,
	// action, pattern, subagent, or call.
	GroupBy string `json:"group_by"`
	// Calls is every call of the tool in the window; rows hold the top ones.
	Calls int64 `json:"calls"`
	// Results is how many of them have a recorded result, the denominator of
	// every failure rate.
	Results  int64      `json:"results,omitempty"`
	Failures int64      `json:"failures,omitempty"`
	Bytes    int64      `json:"bytes,omitempty"`
	Rows     []DrillRow `json:"rows"`
	// Other is the calls in groups below the top rows.
	Other int64 `json:"other"`
	// TrendFromMs and TrendWidthMs place each row's Trend buckets.
	TrendFromMs  int64 `json:"trend_from_ms,omitempty"`
	TrendWidthMs int64 `json:"trend_width_ms,omitempty"`
	// Hints are measured facts worth acting on, strongest first.
	Hints []DrillHint `json:"hints,omitempty"`
}

// DrillRow is one group of calls.
type DrillRow struct {
	Key      string  `json:"key"`
	Calls    int64   `json:"calls"`
	Results  int64   `json:"results,omitempty"`
	Failures int64   `json:"failures,omitempty"`
	Bytes    int64   `json:"bytes,omitempty"`
	Trend    []int64 `json:"trend,omitempty"`
}

// DrillHint is one fact and the row it is about. Weight orders hints: the
// share of the tool's calls, output or failures the fact accounts for.
type DrillHint struct {
	Kind   string  `json:"kind"` // failures, output, repeats
	Key    string  `json:"key"`
	Text   string  `json:"text"`
	Weight float64 `json:"-"`
}

// DrillOptions bounds a drill.
type DrillOptions struct {
	Tool   string
	FromMs int64
	ToMs   int64 // the trend's end; 0 means now as the caller sees it
	Agent  AgentFilter
	Home   string
	Rows   int
	Trend  int
}

// drillTrendBuckets is how many columns a row's trend has.
const drillTrendBuckets = 8

// ToolDrillStats groups one tool's calls. The pre carries the input; its
// post (same session, key post:<id>) carries the result, read through the
// unique (session_id, key) index rather than by scanning results.
func ToolDrillStats(ctx context.Context, q Querier, o DrillOptions) (ToolDrill, error) {
	if o.Rows <= 0 {
		o.Rows = 12
	}
	if o.Trend <= 0 {
		o.Trend = drillTrendBuckets
	}
	scope, args := o.Agent.sessionScope("pr.session_id")
	rows, err := q.QueryContext(ctx, `
		SELECT pr.ts, COALESCE(json_extract(pr.payload, '$.cwd'), ''),
		       COALESCE(json_extract(pr.payload, '$.tool_input.command'), ''),
		       COALESCE(json_extract(pr.payload, '$.tool_input.file_path'), json_extract(pr.payload, '$.tool_input.notebook_path'), ''),
		       COALESCE(json_extract(pr.payload, '$.tool_input.url'), ''),
		       COALESCE(json_extract(pr.payload, '$.tool_input.query'), ''),
		       COALESCE(json_extract(pr.payload, '$.tool_input.action'), json_extract(pr.payload, '$.tool_input.tool_name'), json_extract(pr.payload, '$.tool_input.name'), ''),
		       COALESCE(json_extract(pr.payload, '$.tool_input.pattern'), ''),
		       COALESCE(json_extract(pr.payload, '$.tool_input.subagent_type'), ''),
		       CASE WHEN json_type(pr.payload, '$.tool_input') = 'text' THEN json_extract(pr.payload, '$.tool_input') ELSE '' END,
		       po.id IS NOT NULL, COALESCE(json_extract(po.payload, '$.is_error'), 0), COALESCE(po.tool_bytes, 0)
		FROM events pr
		LEFT JOIN events po ON po.session_id = pr.session_id AND po.key = 'post:' || substr(pr.key, 5)
		WHERE pr.kind = 'tool.pre' AND pr.tool = ? AND pr.ts >= ?`+nonInternalEventPr+scope+`
		ORDER BY pr.ts`, append([]any{o.Tool, o.FromMs}, args...)...)
	if err != nil {
		return ToolDrill{}, err
	}
	defer rows.Close()

	d := ToolDrill{Tool: o.Tool, Kind: drillKind(o.Tool), Rows: []DrillRow{}, Hints: []DrillHint{}}
	groups := map[string]*drillAcc{}
	var first, last int64
	for rows.Next() {
		var (
			ts                                                 int64
			cwd, cmd, file, link, query, action, pat, sub, raw string
			hasPost                                            bool
			isErr                                              int64
			bytes                                              int64
		)
		if err := rows.Scan(&ts, &cwd, &cmd, &file, &link, &query, &action, &pat, &sub, &raw, &hasPost, &isErr, &bytes); err != nil {
			return ToolDrill{}, err
		}
		key, by := drillKey(d.Kind, o.Tool, cwd, cmd, file, link, query, action, pat, sub, raw, o.Home)
		if d.GroupBy == "" || d.GroupBy == "call" {
			d.GroupBy = by
		}
		g := groups[key]
		if g == nil {
			g = &drillAcc{DrillRow: DrillRow{Key: key}}
			groups[key] = g
		}
		g.Calls++
		g.times = append(g.times, ts)
		d.Calls++
		if hasPost {
			g.Results++
			d.Results++
			g.Bytes += bytes
			d.Bytes += bytes
			if isErr != 0 {
				g.Failures++
				d.Failures++
			}
		}
		if first == 0 || ts < first {
			first = ts
		}
		if ts > last {
			last = ts
		}
	}
	if err := rows.Err(); err != nil {
		return ToolDrill{}, err
	}
	if d.GroupBy == "" {
		d.GroupBy = "call"
	}
	all := make([]*drillAcc, 0, len(groups))
	for _, g := range groups {
		all = append(all, g)
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].Calls != all[j].Calls {
			return all[i].Calls > all[j].Calls
		}
		return all[i].Key < all[j].Key
	})

	// The trend spans the window the caller asked for, or — for all of time —
	// from the first call; never past the last moment asked about.
	start := o.FromMs
	if start <= 0 {
		start = first
	}
	end := o.ToMs
	if end <= 0 {
		end = last + 1
	}
	if end <= start {
		end = start + 1
	}
	width := (end - start + int64(o.Trend) - 1) / int64(o.Trend)
	if width <= 0 {
		width = 1
	}
	d.TrendFromMs, d.TrendWidthMs = start, width

	for i, g := range all {
		if i >= o.Rows {
			d.Other += g.Calls
			continue
		}
		g.Trend = make([]int64, o.Trend)
		for _, t := range g.times {
			b := int((t - start) / width)
			if b < 0 {
				b = 0
			}
			if b >= o.Trend {
				b = o.Trend - 1
			}
			g.Trend[b]++
		}
		d.Rows = append(d.Rows, g.DrillRow)
	}
	d.Hints = drillHints(d, all)
	return d, nil
}

// nonInternalEventPr is the internal filter for the pre side of the join.
const nonInternalEventPr = ` AND pr.internal = 0`

// drillKind is how a tool's calls are grouped.
func drillKind(tool string) string {
	switch {
	case tool == "Bash" || tool == "exec" || tool == "shell" || tool == "exec_command" || tool == "local_shell":
		return "shell"
	case tool == "Read" || tool == "Edit" || tool == "Write" || tool == "MultiEdit" || tool == "NotebookEdit" || tool == "NotebookRead":
		return "files"
	case tool == "WebFetch" || tool == "WebSearch" || tool == "web_search":
		return "web"
	case strings.HasPrefix(tool, "mcp__"):
		return "mcp"
	}
	return "other"
}

// Codex's exec tool wraps its calls in a script: tools.exec_command({cmd:
// "..."}) for a shell command, tools.web__run(...) for the web.
var (
	codexCmd  = regexp.MustCompile(`cmd:\s*"((?:[^"\\]|\\.)*)"`)
	codexTool = regexp.MustCompile(`tools\.([A-Za-z0-9_]+)\(`)
)

// drillKey is the group a call belongs to, and what that group is called.
func drillKey(kind, tool, cwd, cmd, file, link, query, action, pat, sub, raw, home string) (string, string) {
	switch kind {
	case "shell":
		if cmd == "" && raw != "" {
			if m := codexCmd.FindStringSubmatch(raw); m != nil {
				if s, err := strconv.Unquote(`"` + m[1] + `"`); err == nil {
					cmd = s
				} else {
					cmd = m[1]
				}
			} else if m := codexTool.FindStringSubmatch(raw); m != nil {
				return m[1], "call"
			}
		}
		if h := commandHead(cmd, cwd); h != "" {
			return h, "command"
		}
	case "files":
		if file != "" {
			return homeRel(file, home), "file"
		}
	case "web":
		if link != "" {
			if u, err := url.Parse(link); err == nil && u.Host != "" {
				return strings.TrimPrefix(strings.ToLower(u.Host), "www."), "domain"
			}
		}
		if query != "" {
			return clipRunes(strings.ToLower(strings.TrimSpace(query)), 60), "query"
		}
	case "mcp":
		if action != "" {
			return clipRunes(action, 60), "action"
		}
		if link != "" {
			if u, err := url.Parse(link); err == nil && u.Host != "" {
				return strings.ToLower(u.Host), "domain"
			}
		}
	default:
		switch {
		case sub != "":
			return sub, "subagent"
		case pat != "":
			return clipRunes(pat, 60), "pattern"
		case cmd != "":
			if h := commandHead(cmd, cwd); h != "" {
				return h, "command"
			}
		}
	}
	return "(no detail)", "call"
}

// heads whose next word says what they did: "git commit", "go test".
var subcommandHeads = map[string]int{
	"git": 1, "gh": 2, "go": 1, "npm": 1, "pnpm": 1, "yarn": 1, "npx": 1, "bun": 1, "make": 1,
	"docker": 1, "kubectl": 1, "cargo": 1, "brew": 1, "uv": 1, "pip": 1, "pip3": 1,
	"terraform": 1, "aws": 1, "gcloud": 1, "caprock": 1, "claude": 1, "codex": 1,
}

// shellNoise are statements that only set the stage for the command.
var shellNoise = map[string]bool{"export": true, "set": true, "source": true, ".": true, "pushd": true, "popd": true, "unset": true, "true": true, ":": true}

// commandHead is what a shell call ran, as a reader names it: the first
// statement that is not setup, by its program's name and, for tools whose
// subcommand is the point, the subcommand ("git commit", "gh pr create").
func commandHead(cmd, cwd string) string {
	for _, st := range splitShell(cmd, cwd) {
		w := st.words
		if len(w) == 0 || shellNoise[w[0]] {
			continue
		}
		head := filepath.Base(w[0])
		if head == "sudo" && len(w) > 1 {
			w = w[1:]
			head = filepath.Base(w[0])
		}
		if head == "git" {
			if sub, _ := gitSubcommand(shellStatement{words: w, dir: st.dir}); sub != "" {
				return "git " + sub
			}
			return "git"
		}
		parts := []string{head}
		for i := 1; i < len(w) && len(parts) <= subcommandHeads[head]; i++ {
			a := w[i]
			if strings.HasPrefix(a, "-") || strings.ContainsAny(a, "/=$") {
				break
			}
			parts = append(parts, a)
		}
		return clipRunes(strings.Join(parts, " "), 48)
	}
	return ""
}

func homeRel(p, home string) string {
	if home != "" && (p == home || strings.HasPrefix(p, home+string(filepath.Separator)) || strings.HasPrefix(p, home+"/")) {
		return "~" + p[len(home):]
	}
	return p
}

func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

type drillAcc struct {
	DrillRow
	times []int64
}

// drillHints states what the counts show and nothing else: the group that
// fails far more than the tool does, the group that returns most of the
// output, and the group the calls pile up on. Each needs enough calls to be a
// pattern rather than an accident, and the strongest comes first.
func drillHints(d ToolDrill, all []*drillAcc) []DrillHint {
	out := []DrillHint{}
	noun := map[string]string{"command": "", "file": "", "domain": "", "query": "the search ", "action": "", "pattern": "", "subagent": "the ", "call": ""}[d.GroupBy]
	name := func(k string) string { return noun + "`" + k + "`" }
	overall := pct(d.Failures, d.Results)
	var worst *drillAcc
	for _, g := range all {
		if g.Results < 20 || g.Failures < 5 {
			continue
		}
		r := pct(g.Failures, g.Results)
		if r < 10 || r < 2*overall {
			continue
		}
		if worst == nil || r > pct(worst.Failures, worst.Results) {
			worst = g
		}
	}
	if worst != nil {
		r := pct(worst.Failures, worst.Results)
		out = append(out, DrillHint{
			Kind: "failures", Key: worst.Key, Weight: pct(worst.Failures, d.Failures) / 100,
			Text: fmt.Sprintf("%s failed %d of %d times (%.0f%%), against %.0f%% for %s overall.", name(worst.Key), worst.Failures, worst.Results, r, overall, d.Tool),
		})
	}
	if d.Bytes > 0 {
		var big *drillAcc
		for _, g := range all {
			if g.Calls >= 10 && (big == nil || g.Bytes > big.Bytes) {
				big = g
			}
		}
		// With one group the share is 100% by construction, which says nothing.
		if big != nil && len(all) > 1 && pct(big.Bytes, d.Bytes) >= 25 && big.Key != "(no detail)" {
			out = append(out, DrillHint{
				Kind: "output", Key: big.Key, Weight: pct(big.Bytes, d.Bytes) / 100,
				Text: fmt.Sprintf("%s returned %s in %d calls — %.0f%% of everything %s returned to the model.", name(big.Key), fmtBytes(big.Bytes), big.Calls, pct(big.Bytes, d.Bytes), d.Tool),
			})
		}
	}
	if len(all) > 1 && all[0].Calls >= 50 && pct(all[0].Calls, d.Calls) >= 30 && all[0].Key != "(no detail)" {
		top := all[0]
		out = append(out, DrillHint{
			Kind: "repeats", Key: top.Key, Weight: pct(top.Calls, d.Calls) / 100,
			Text: fmt.Sprintf("%s is %.0f%% of %s calls (%d of %d).", name(top.Key), pct(top.Calls, d.Calls), d.Tool, top.Calls, d.Calls),
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Weight > out[j].Weight })
	return out
}

func pct(a, b int64) float64 {
	if b <= 0 {
		return 0
	}
	return 100 * float64(a) / float64(b)
}

func fmtBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}
