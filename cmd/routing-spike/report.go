package main

import (
	"fmt"
	"sort"
	"strings"
)

// Thresholds the spec asks to be reported at.
var (
	readLineThresholds = []int{150, 350}
	toolTokThresholds  = []int{2000, 4000}
)

// ClassStat is one row of the per-class table.
type ClassStat struct {
	Class      Class   `json:"class"`
	Events     int     `json:"events"`
	Tokens     int     `json:"tokens"`
	TokenTurns int     `json:"token_turns"`
	Bytes      int     `json:"bytes"`
	Estimated  int     `json:"estimated_events"`
	P50        int     `json:"p50_tokens"`
	P90        int     `json:"p90_tokens"`
	P99        int     `json:"p99_tokens"`
	AboveA     int     `json:"above_a"` // reads: >=150 lines; others: >=2k tokens
	AboveB     int     `json:"above_b"` // reads: >=350 lines; others: >=4k tokens
	AboveBTok  int     `json:"above_b_tokens"`
	AboveBTT   int     `json:"above_b_token_turns"`
	ShareTT    float64 `json:"share_token_turns"` // of the whole denominator
	ShareAbove float64 `json:"share_above_b"`     // routable part only
}

type ProjectStat struct {
	Project    string  `json:"project"`
	Sessions   int     `json:"sessions"`
	TokenTurns int     `json:"context_token_turns"`
	RoutableTT int     `json:"routable_token_turns"`
	Share      float64 `json:"share"`
}

// Report is the whole answer, in one value so `-json` and the text renderer
// cannot drift apart.
type Report struct {
	Root         string        `json:"root"`
	FilesScanned int           `json:"files_scanned"`
	Sessions     int           `json:"sessions"`
	Events       int           `json:"events"`
	ContextTT    int           `json:"context_token_turns"`
	Classes      []ClassStat   `json:"classes"`
	Projects     []ProjectStat `json:"projects"`
	TurnsLeft    Dist          `json:"turns_left"`
	SessionTurns Dist          `json:"session_turns"`
	Bash         BashCheck     `json:"bash_check"`
	Verdict      Verdict       `json:"verdict"`
}

type Dist struct {
	P50 int `json:"p50"`
	P90 int `json:"p90"`
	P99 int `json:"p99"`
	Max int `json:"max"`
}

// BashCheck answers the owner's specific question: his impression that Bash is
// most of the spend comes from per-call attribution, where every call re-sends
// the whole context. That is a different quantity from the size of what Bash
// returns, and routing only addresses the second.
type BashCheck struct {
	Calls            int     `json:"calls"`
	ShareOfToolCalls float64 `json:"share_of_tool_calls"`
	ContextAtCall    int     `json:"mean_context_at_call"`
	ShareByCall      float64 `json:"share_by_call_attribution"`
	ShareByResult    float64 `json:"share_by_result_size"`
}

type Verdict struct {
	RoutableShare float64 `json:"routable_share"`
	ReadShare     float64 `json:"read_share"`
	BashShare     float64 `json:"bash_share"`
	MCPTextShare  float64 `json:"mcp_text_share"`
	BashAbovePct  float64 `json:"bash_above_threshold_pct"`
	EstimatorPass bool    `json:"estimator_pass"`
	BashPass      bool    `json:"bash_track_pass"`
}

// Analyse turns parsed sessions into the report.
func Analyse(sessions []Session) Report {
	r := Report{Sessions: len(sessions)}

	byClass := map[Class]*ClassStat{}
	byProject := map[string]*ProjectStat{}
	var turnsLeft, sessTurns []int
	var bashCtx, bashCalls, toolCalls int

	for _, s := range sessions {
		r.ContextTT += s.ContextTokenTurns
		r.Events += len(s.Events)
		bashCalls += s.BashCalls
		toolCalls += s.ToolCalls
		if s.AssistantTurns > 0 {
			sessTurns = append(sessTurns, s.AssistantTurns)
			// Mean context carried at the moment a tool is called, used for the
			// per-call attribution figure below.
			bashCtx += s.ContextTokenTurns / s.AssistantTurns * s.BashCalls
		}

		p := byProject[s.Project]
		if p == nil {
			p = &ProjectStat{Project: s.Project}
			byProject[s.Project] = p
		}
		p.Sessions++
		p.TokenTurns += s.ContextTokenTurns

		for _, e := range s.Events {
			c := byClass[e.Class]
			if c == nil {
				c = &ClassStat{Class: e.Class}
				byClass[e.Class] = c
			}
			c.Events++
			c.Tokens += e.Tokens
			c.TokenTurns += e.TokenTurns()
			c.Bytes += e.Bytes
			if e.Estimated {
				c.Estimated++
			}
			turnsLeft = append(turnsLeft, e.TurnsLeft)

			if aboveA(e) {
				c.AboveA++
			}
			if aboveB(e) {
				c.AboveB++
				c.AboveBTok += e.Tokens
				c.AboveBTT += e.TokenTurns()
				if e.Class.Routable() {
					p.RoutableTT += e.TokenTurns()
				}
			}
		}
	}

	// Percentiles need the per-event values, gathered in a second pass to keep
	// the first one cheap on memory.
	perClass := map[Class][]int{}
	for _, s := range sessions {
		for _, e := range s.Events {
			perClass[e.Class] = append(perClass[e.Class], e.Tokens)
		}
	}
	for cl, st := range byClass {
		v := perClass[cl]
		st.P50, st.P90, st.P99 = pct(v, 50), pct(v, 90), pct(v, 99)
		if r.ContextTT > 0 {
			st.ShareTT = 100 * float64(st.TokenTurns) / float64(r.ContextTT)
			st.ShareAbove = 100 * float64(st.AboveBTT) / float64(r.ContextTT)
		}
		r.Classes = append(r.Classes, *st)
	}
	sort.Slice(r.Classes, func(i, j int) bool { return r.Classes[i].TokenTurns > r.Classes[j].TokenTurns })

	for _, p := range byProject {
		if p.TokenTurns > 0 {
			p.Share = 100 * float64(p.RoutableTT) / float64(p.TokenTurns)
		}
		r.Projects = append(r.Projects, *p)
	}
	sort.Slice(r.Projects, func(i, j int) bool { return r.Projects[i].TokenTurns > r.Projects[j].TokenTurns })

	r.TurnsLeft = dist(turnsLeft)
	r.SessionTurns = dist(sessTurns)

	// The Bash question, both ways round.
	var bashResultTok, allResultTok int
	for _, s := range sessions {
		for _, e := range s.Events {
			allResultTok += e.Tokens
			if e.Class == ClassBash {
				bashResultTok += e.Tokens
			}
		}
	}
	r.Bash = BashCheck{Calls: bashCalls}
	if toolCalls > 0 {
		r.Bash.ShareOfToolCalls = 100 * float64(bashCalls) / float64(toolCalls)
	}
	if bashCalls > 0 {
		r.Bash.ContextAtCall = bashCtx / bashCalls
	}
	if r.ContextTT > 0 {
		// What per-call attribution would say: every Bash call is charged the
		// whole context it was made against.
		r.Bash.ShareByCall = 100 * float64(bashCtx) / float64(r.ContextTT)
	}
	if allResultTok > 0 {
		r.Bash.ShareByResult = 100 * float64(bashResultTok) / float64(allResultTok)
	}

	r.Verdict = verdict(byClass)
	return r
}

func aboveA(e Event) bool {
	if e.Class == ClassRead || e.Class == ClassReadImg || e.Class == ClassReadTgt {
		return e.Lines >= readLineThresholds[0]
	}
	return e.Tokens >= toolTokThresholds[0]
}

func aboveB(e Event) bool {
	if e.Class == ClassRead || e.Class == ClassReadImg || e.Class == ClassReadTgt {
		return e.Lines >= readLineThresholds[1]
	}
	return e.Tokens >= toolTokThresholds[1]
}

func verdict(byClass map[Class]*ClassStat) Verdict {
	v := Verdict{}
	get := func(c Class) *ClassStat {
		if s := byClass[c]; s != nil {
			return s
		}
		return &ClassStat{}
	}
	read, bash, mcp := get(ClassRead), get(ClassBash), get(ClassMCPText)
	v.ReadShare, v.BashShare, v.MCPTextShare = read.ShareAbove, bash.ShareAbove, mcp.ShareAbove
	v.RoutableShare = v.ReadShare + v.BashShare + v.MCPTextShare
	if bash.Tokens > 0 {
		// The Bash-track criterion is stated against Bash's own tokens, not
		// against the whole context.
		v.BashAbovePct = 100 * float64(bashAboveTokens(byClass)) / float64(bash.Tokens)
	}
	// Per the spec: any single routable class at or above 15% is enough to
	// proceed; the Bash track needs 20% of Bash's own tokens.
	v.EstimatorPass = v.ReadShare >= 15 || v.BashShare >= 15 || v.MCPTextShare >= 15
	v.BashPass = v.BashAbovePct >= 20
	return v
}

// bashAboveTokens is the token volume of Bash results over the 4k threshold.
func bashAboveTokens(byClass map[Class]*ClassStat) int {
	if s := byClass[ClassBash]; s != nil {
		return s.AboveBTok
	}
	return 0
}

func pct(v []int, p int) int {
	if len(v) == 0 {
		return 0
	}
	s := append([]int(nil), v...)
	sort.Ints(s)
	i := len(s) * p / 100
	if i >= len(s) {
		i = len(s) - 1
	}
	return s[i]
}

func dist(v []int) Dist {
	if len(v) == 0 {
		return Dist{}
	}
	s := append([]int(nil), v...)
	sort.Ints(s)
	return Dist{P50: pct(s, 50), P90: pct(s, 90), P99: pct(s, 99), Max: s[len(s)-1]}
}

func mb(n int) string { return fmt.Sprintf("%.1f", float64(n)/(1<<20)) }

func kt(n int) string {
	switch {
	case n >= 1_000_000_000:
		return fmt.Sprintf("%.1fB", float64(n)/1e9)
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1_000:
		return fmt.Sprintf("%.1fk", float64(n)/1e3)
	}
	return fmt.Sprint(n)
}

// Text renders the report for a human. The JSON form carries the same numbers.
func (r Report) Text(withBytes bool) string {
	var b strings.Builder
	f := func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }

	f("routing spike\n")
	f("  root      %s\n", r.Root)
	f("  scanned   %d transcripts, %d sessions parsed\n", r.FilesScanned, r.Sessions)
	f("  events    %d tool results\n", r.Events)
	f("  context   %s token-turns (the denominator)\n\n", kt(r.ContextTT))

	f("BY CLASS  (token-turns = T x (1 + turns_left))\n")
	f("  %-9s %7s %9s %11s %7s  %s\n", "class", "events", "tokens", "tok-turns", "share", "p50/p90/p99")
	for _, c := range r.Classes {
		mark := ""
		if !c.Class.Routable() {
			mark = "  (not routable)"
		}
		f("  %-9s %7d %9s %11s %6.2f%%  %d/%d/%d%s\n",
			c.Class, c.Events, kt(c.Tokens), kt(c.TokenTurns), c.ShareTT, c.P50, c.P90, c.P99, mark)
	}

	f("\nABOVE THRESHOLD  (reads: lines; bash/mcp: tokens)\n")
	f("  %-9s %10s %10s %14s\n", "class", ">=150/2k", ">=350/4k", "share of ctx")
	for _, c := range r.Classes {
		if !c.Class.Routable() {
			continue
		}
		f("  %-9s %10d %10d %13.2f%%\n", c.Class, c.AboveA, c.AboveB, c.ShareAbove)
	}

	if withBytes {
		f("\nBYTES vs TOKENS  (why the first pass of this spike was wrong)\n")
		f("  %-9s %10s %10s %10s %10s\n", "class", "MB", "% of MB", "tokens", "% of tok")
		totB, totT := 0, 0
		for _, c := range r.Classes {
			totB += c.Bytes
			totT += c.Tokens
		}
		for _, c := range r.Classes {
			pb, pt := 0.0, 0.0
			if totB > 0 {
				pb = 100 * float64(c.Bytes) / float64(totB)
			}
			if totT > 0 {
				pt = 100 * float64(c.Tokens) / float64(totT)
			}
			f("  %-9s %10s %9.1f%% %10s %9.1f%%\n", c.Class, mb(c.Bytes), pb, kt(c.Tokens), pt)
		}
	}

	f("\nHOW LONG SESSIONS RUN\n")
	f("  assistant turns per session   p50 %d  p90 %d  p99 %d  max %d\n",
		r.SessionTurns.P50, r.SessionTurns.P90, r.SessionTurns.P99, r.SessionTurns.Max)
	f("  turns_left per event          p50 %d  p90 %d  p99 %d  max %d\n",
		r.TurnsLeft.P50, r.TurnsLeft.P90, r.TurnsLeft.P99, r.TurnsLeft.Max)

	f("\nBASH: TWO WAYS OF COUNTING\n")
	f("  calls                              %d (%.0f%% of all tool calls)\n", r.Bash.Calls, r.Bash.ShareOfToolCalls)
	f("  mean context carried at each call  %s tokens\n", kt(r.Bash.ContextAtCall))
	f("  share by per-call attribution      %.1f%%   <- the impression\n", r.Bash.ShareByCall)
	f("  share by size of what Bash returns %.1f%%   <- what routing could remove\n", r.Bash.ShareByResult)

	f("\nBY PROJECT  (top 12 by context)\n")
	f("  %-22s %5s %12s %9s\n", "project", "sess", "ctx tok-turns", "routable")
	for i, p := range r.Projects {
		if i >= 12 {
			break
		}
		f("  %-22s %5d %12s %8.2f%%\n", trunc(p.Project, 22), p.Sessions, kt(p.TokenTurns), p.Share)
	}

	f("\nKILL CRITERIA\n")
	f("  estimator needs one routable class >= 15%% of context token-turns\n")
	f("    read      %5.2f%%\n", r.Verdict.ReadShare)
	f("    bash      %5.2f%%\n", r.Verdict.BashShare)
	f("    mcp_text  %5.2f%%\n", r.Verdict.MCPTextShare)
	f("    -> %s\n", pass(r.Verdict.EstimatorPass))
	f("  bash track needs results above threshold >= 20%% of bash tokens\n")
	f("    %5.2f%%  -> %s\n", r.Verdict.BashAbovePct, pass(r.Verdict.BashPass))
	return b.String()
}

func pass(ok bool) string {
	if ok {
		return "PASS"
	}
	return "FAIL"
}

func trunc(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
