package main

import (
	"sort"
	"strings"
)

// A series is a maximal run of consecutive tool calls with no user message
// between them and no compaction boundary inside (spec §5.3).
//
// It is the unit this spike is about. The cost of a loop is not what its calls
// return; it is the context each one re-reads. A series of twelve Bash calls at
// 380k context pays that 380k twelve times over before doing any work.
type Series struct {
	Session string `json:"session"`
	Project string `json:"project"`
	Start   int    `json:"start_turn"`
	N       int    `json:"n"`
	CStart  int    `json:"c_start"`
	CEnd    int    `json:"c_end"`
	Class   string `json:"class"`
	HasEdit bool   `json:"has_edit"`
	// SelfContained: every Edit in the series targets a file the same series
	// first created with Write. Such a loop owns everything it touches, so
	// isolating it cannot clobber work that predates it.
	SelfContained bool `json:"self_contained"`
	// EditLoop: the series edits files it did not create. Whether these can be
	// isolated is not answerable from a transcript — it turns on whether the
	// loop needs the conversation's history — so they are their own category
	// for Stage 2 to settle by experiment.
	EditLoop bool   `json:"edit_loop"`
	TaxTok   int    `json:"tax_tokens"`    // sum of C_i, the context re-read
	ResultTk int    `json:"result_tokens"` // sum of R_i
	TurnsEnd int    `json:"turns_left_end"`
	Model    string `json:"model"`
	Eligible bool   `json:"eligible"`
	Why      string `json:"why,omitempty"` // why not eligible
}

// classifySeries names a series by what its commands mostly do. Prefix rules
// are the floor the spec asks for: explainable in a UI, and wrong in ways a
// reader can see rather than in ways they cannot.
func classifySeries(cmds []string) string {
	counts := map[string]int{}
	for _, c := range cmds {
		counts[classifyCommand(c)]++
	}
	best, bestN := "run", 0
	for k, v := range counts {
		if v > bestN || (v == bestN && k < best) {
			best, bestN = k, v
		}
	}
	// A series is only called by its class when that class actually dominates;
	// otherwise it is mixed, and mixed loops are the ones a classifier should
	// not be confident about.
	if len(cmds) > 0 && bestN*2 <= len(cmds) {
		return "mixed"
	}
	return best
}

func classifyCommand(cmd string) string {
	c := strings.TrimSpace(strings.ToLower(cmd))
	// Strip a leading `cd ... &&`, which prefixes a large share of real
	// commands and would otherwise classify everything as "run".
	for {
		trimmed := false
		for _, sep := range []string{"&&", ";"} {
			if i := strings.Index(c, sep); i > 0 && strings.HasPrefix(c, "cd ") {
				c = strings.TrimSpace(c[i+len(sep):])
				trimmed = true
			}
		}
		if !trimmed {
			break
		}
	}
	first := c
	if i := strings.IndexAny(c, " \t"); i > 0 {
		first = c[:i]
	}
	switch {
	case hasAny(c, "go test", "npm test", "pytest", "jest", "cargo test", "vitest", "make test", "npx vitest"):
		return "test"
	case hasAny(c, "go build", "npm run build", "tsc", "make build", "cargo build", "make ", "go vet", "gofmt", "golangci"):
		return "build"
	case first == "git":
		return "vcs"
	case first == "grep" || first == "rg" || first == "find" || first == "ls" || first == "awk" || first == "sed":
		return "search"
	case hasAny(c, "npm install", "npm ci", "pip install", "go mod", "brew install", "go get"):
		return "pkg"
	default:
		return "run"
	}
}

func hasAny(s string, subs ...string) bool {
	for _, x := range subs {
		if strings.Contains(s, x) {
			return true
		}
	}
	return false
}

// Eligibility thresholds (spec §5.3), overridable for the sensitivity sweep.
type Rule struct {
	MinN      int
	MinCStart int
	// AllowEdits treats a series containing Edit/Write as eligible. Off by
	// default because the spec forbids delegating editing; available because
	// on this archive that one rule refuses the most expensive series, and a
	// verdict should be readable with and without it.
	AllowEdits bool
}

// DefaultRule is what the Stage 0 kill criterion is stated against.
var DefaultRule = Rule{MinN: 5, MinCStart: 200_000}

// DetectSeries walks a session's events in order and cuts them into series.
//
// The boundary rules come straight from the spec: a user message ends a series
// (the loop is over, a human said something), and so does a compaction (the
// context it was paying for is gone). Both are recorded during parsing.
func DetectSeries(s Session, rule Rule) []Series {
	var out []Series
	var cur []Event
	flush := func() {
		if len(cur) == 0 {
			return
		}
		out = append(out, buildSeries(s, cur, rule))
		cur = nil
	}
	for _, e := range s.Events {
		if e.BreaksSeries {
			flush()
			continue
		}
		// Only tool calls that carry a context reading can be priced; an event
		// with no context is one whose issuing turn had no usage.
		if e.ContextAtCall == 0 {
			continue
		}
		if len(cur) > 0 && e.Turn != cur[len(cur)-1].Turn && e.UserBefore {
			flush()
		}
		cur = append(cur, e)
	}
	flush()
	return out
}

func buildSeries(s Session, ev []Event, rule Rule) Series {
	var cmds []string
	sr := Series{
		Session:  s.ID,
		Project:  s.Project,
		Start:    ev[0].Turn,
		N:        len(ev),
		CStart:   ev[0].ContextAtCall,
		CEnd:     ev[len(ev)-1].ContextAtCall,
		Model:    s.Model,
		TurnsEnd: ev[len(ev)-1].TurnsLeft,
	}
	// created tracks files this series wrote itself, so an Edit to something
	// the loop made is told apart from an edit to something that was already
	// there when it began.
	created := map[string]bool{}
	editsOutside := false
	for _, e := range ev {
		sr.TaxTok += e.ContextAtCall
		sr.ResultTk += e.Tokens
		switch e.Tool {
		case "Write":
			sr.HasEdit = true
			if e.Path != "" {
				created[e.Path] = true
			}
		case "Edit", "MultiEdit", "NotebookEdit":
			sr.HasEdit = true
			// An edit whose path was not recorded cannot be shown to be
			// self-contained, so it counts as foreign. Unknown provenance is
			// treated as the worse case: this decides whether real work gets
			// moved into a subagent.
			if e.Path == "" || !created[e.Path] {
				editsOutside = true
			}
		}
		if e.Command != "" {
			cmds = append(cmds, e.Command)
		}
	}
	sr.SelfContained = sr.HasEdit && !editsOutside
	sr.EditLoop = editsOutside
	sr.Class = classifySeries(cmds)

	switch {
	case sr.N < rule.MinN:
		sr.Why = "too short"
	case sr.CStart < rule.MinCStart:
		sr.Why = "context below threshold"
	case sr.EditLoop && !rule.AllowEdits:
		// Edits to files the series did not itself create. Refused not because
		// such a loop is unsuitable — that is unknown — but because a
		// transcript cannot say whether it needs the conversation's history.
		// Stage 2 settles it by experiment; until then it is its own category
		// rather than a flat no.
		sr.Why = "edits pre-existing files"
	default:
		sr.Eligible = true
	}
	return sr
}

// Isolation is the §5.4 counterfactual for one series.
type Isolation struct {
	CostActual   float64 `json:"cost_actual"`
	CostIsolated float64 `json:"cost_isolated"`
	Saved        float64 `json:"saved"`
}

// Prices per million tokens for one model.
type Prices struct {
	In float64
}

func (p Prices) cacheRead() float64  { return 0.10 * p.In }
func (p Prices) cacheWrite() float64 { return 1.25 * p.In }

// IsolateSeries prices a series as it ran, and as it would have run inside a
// subagent that starts from a small context (spec §5.4).
//
// The saving is not the subagent being cheaper per token — with same-model
// isolation the prices are identical. It is that the subagent never re-reads
// the parent's 380k context: it starts near zero and grows only by its own
// results.
func IsolateSeries(sr Series, ev []Event, parent, sub Prices, cSub0, summary, brief int) Isolation {
	const perM = 1_000_000.0
	var iso Isolation

	for _, e := range ev {
		iso.CostActual += float64(e.ContextAtCall) * parent.cacheRead() / perM
		iso.CostActual += float64(e.Tokens) * parent.cacheWrite() / perM
		iso.CostActual += float64(e.Tokens) * float64(e.TurnsLeft) * parent.cacheRead() / perM
	}

	acc := cSub0
	for _, e := range ev {
		iso.CostIsolated += float64(acc) * sub.cacheRead() / perM
		iso.CostIsolated += float64(e.Tokens) * sub.cacheWrite() / perM
		acc += e.Tokens
	}
	// What comes back to the parent, and the brief that was written to send it.
	iso.CostIsolated += float64(summary) * parent.cacheWrite() / perM
	iso.CostIsolated += float64(summary) * float64(sr.TurnsEnd) * parent.cacheRead() / perM
	iso.CostIsolated += float64(brief) * parent.cacheWrite() / perM

	iso.Saved = iso.CostActual - iso.CostIsolated
	return iso
}

// CompactionAt is the §5.5 counterfactual: what compacting at point k would
// have saved for the calls after it.
func CompactionAt(ev []Event, k int, p Prices, ratio float64, summaryTok int) float64 {
	const perM = 1_000_000.0
	if k < 0 || k >= len(ev) {
		return 0
	}
	compacted := float64(ev[k].ContextAtCall) * ratio
	var saved float64
	for _, e := range ev[k+1:] {
		d := float64(e.ContextAtCall) - compacted
		if d > 0 {
			saved += d * p.cacheRead() / perM
		}
	}
	return saved - float64(summaryTok)*p.cacheWrite()/perM
}

// SortSeries orders by tax, so the expensive loops come first.
func SortSeries(s []Series) {
	sort.Slice(s, func(i, j int) bool { return s[i].TaxTok > s[j].TaxTok })
}
