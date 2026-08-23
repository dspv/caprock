package store

import "sort"

// Work-kind attribution — charging a turn's cost to the KIND of work it did,
// so the Cost screen can answer "what was the money spent ON?" beside the
// existing "which model" and "which project".
//
// THE QUESTION THIS ANSWERS. The Cost screen already says how much and where.
// It cannot say on what: a $200 day looks identical whether it was spent
// running the test suite, editing files, or reading the codebase. The kind of
// work a turn did is not in any of the existing cuts, and it is the one cut
// with no answer anywhere else.
//
// THE CONSTRAINT, SAME AS PER-DIRECTORY ATTRIBUTION. Cost lives on
// turn.assistant and nowhere else: SUM(cost_usd) over tool.pre is exactly 0. A
// work kind is therefore never charged directly — a TURN is charged, and the
// turn's kind is decided by the tools that turn called.
//
// THE LINKAGE IS msg_id, AND IT IS EXACT. A tool_use block and the usage billed
// for it are content blocks of the SAME assistant message, so they share its id
// by construction (see § Touch attribution DDL). This is the same join the
// per-directory breakdown was built on, and deliberately not a second
// mechanism.
//
// WHY THIS IS NOT CARRY-FORWARD. Per-directory attribution carries a directory
// forward across turns because work happens in stretches: the commands and
// searches between two edits are part of the same piece of work on the same
// directory. Work KIND is the opposite — it is a property of the turn itself,
// not of a stretch. A turn that ran the test suite did command work whether or
// not the turn before it edited a file, and carrying "edits" forward onto it
// would report editing that did not happen. So a turn is classified by ITS OWN
// tool calls, and a turn that called nothing is its own category rather than
// inheriting one.
//
// EXACTLY ONE CATEGORY PER TURN. A turn's cost is billed as one amount and goes
// WHOLE to one row, never split — consistent with how directory attribution
// already refuses to divide a turn. When a turn calls tools from more than one
// category the precedence below decides, and the rule is stated to the user
// (WorkKindRule) rather than left implicit. On the owner's database only 2503
// of 57521 tool-using turns (4.4%) call tools from more than one category, and
// they carry 2.2% of all spend (measured 2026-08-23, all time), so the
// precedence moves very little money — but it must still be stated, because a
// reader cannot check a rule they cannot see.

// WorkKind is the kind of work one turn did. It is a closed set: every turn
// lands in exactly one of these, and they sum to the total.
type WorkKind string

// The categories.
//
// WHY THESE, AND WHAT WAS REJECTED. The cut has to survive the question "is
// that label true?" for every turn it puts in a row, because a flattering label
// is an invented number in words (rule 6).
//
//   - Edits and commands are separated because they are the two halves of
//     writing software that cost differently and are acted on differently: an
//     edit-heavy bill and a command-heavy bill suggest opposite things about
//     where the time goes.
//   - Reading and searching are ONE row, not two. Read, Grep and Glob are the
//     same activity from the model's side — pulling context into the prompt so
//     it can be reasoned about — and the cost driver is identical: the contents
//     enter the prompt and are billed. Splitting them would invite the reader
//     to compare two numbers that mean the same thing.
//   - Web research is its own row rather than folded into "other". Fetching and
//     searching the web is a distinct, recognisable activity whose cost a user
//     can act on (it pulls large pages into the prompt), and on the owner's
//     database it is a real 1.8% rather than a rounding error.
//   - MCP tools are their own row because they are the user's OWN integrations.
//     Folding a browser-automation or scraping tool into "other" would hide the
//     cost of the thing the user added themselves, which is exactly the cost
//     they are most able to change.
//   - "No tool" is called what it is. It is NOT labelled "conversation",
//     "thinking" or "planning": a turn that called no tool may be answering a
//     question, reasoning, planning, or simply writing prose, and picking one of
//     those as the label would assert something the data does not say. The
//     honest statement is the mechanical one — this turn called no tool — and
//     the UI says exactly that.
const (
	// WorkNone is a turn that called no tool at all. Named for what is
	// observable (no tool call), never for what it might have been doing.
	WorkNone WorkKind = "none"
	// WorkEdit is a turn that wrote to a file.
	WorkEdit WorkKind = "edit"
	// WorkCommand is a turn that ran a shell command.
	WorkCommand WorkKind = "command"
	// WorkRead is a turn that read or searched the codebase.
	WorkRead WorkKind = "read"
	// WorkWeb is a turn that fetched or searched the web.
	WorkWeb WorkKind = "web"
	// WorkMCP is a turn that called an MCP tool — the user's own integrations.
	WorkMCP WorkKind = "mcp"
	// WorkOther is a turn that called a tool belonging to none of the above:
	// agent and task control, skills, structured output. It is deliberately
	// last and deliberately vague-sounding, because its members genuinely have
	// nothing in common but "not one of the named kinds".
	WorkOther WorkKind = "other"
)

// WorkKindRule is the statement of how a turn is placed, shown in the UI so the
// number is not a black box — the same contract TouchRule holds for the
// per-directory breakdown.
//
// The precedence is ordered by what the turn most concretely DID, strongest
// evidence first: writing a file is a stronger statement about a turn than
// running a command, which is stronger than reading. It is not ordered by cost,
// which would let the ranking rewrite itself as the data changed.
const WorkKindRule = "Each turn counts toward one kind of work, decided by the tools it called: writing a file wins over running a command, which wins over reading or searching, then web, then an MCP tool, then anything else. A turn that called no tool at all is counted as exactly that — it may have been reasoning, planning or answering, and Caprock does not claim to know which. Each turn's cost goes whole to one kind, never split, so the rows add up to the total exactly."

// workKindOf maps one tool name to the kind of work it represents.
//
// UNKNOWN TOOLS FALL TO WorkOther RATHER THAN BEING DROPPED. A tool Caprock has
// never seen is still work that was paid for, and dropping it would stop the
// rows summing to the total (rule 6). New first-party tools therefore appear in
// "other" until they are named here, which is visible and honest, rather than
// silently vanishing.
//
// The MCP test is the `mcp__` prefix, which is Claude Code's own namespacing
// convention for them and the only reliable signal — an MCP server can name its
// tools anything after that prefix.
func workKindOf(tool string) WorkKind {
	switch tool {
	case "Edit", "Write", "NotebookEdit", "MultiEdit":
		return WorkEdit
	case "Bash", "BashOutput", "KillShell":
		return WorkCommand
	case "Read", "Grep", "Glob", "NotebookRead", "ToolSearch":
		return WorkRead
	case "WebFetch", "WebSearch":
		return WorkWeb
	}
	if len(tool) >= 5 && tool[:5] == "mcp__" {
		return WorkMCP
	}
	return WorkOther
}

// workKindRank orders the categories for the precedence rule. A LOWER rank
// wins, so a turn that both edited and read is an edit.
//
// WorkNone is not in this ordering at all: it is not a competing claim about a
// turn but the absence of any claim, and it is reached only when a turn called
// nothing. Giving it a rank would let it win over a real tool call.
func workKindRank(k WorkKind) int {
	switch k {
	case WorkEdit:
		return 0
	case WorkCommand:
		return 1
	case WorkRead:
		return 2
	case WorkWeb:
		return 3
	case WorkMCP:
		return 4
	}
	return 5 // WorkOther
}

// WorkKindOfTurn decides the single kind a turn belongs to from the tools it
// called. An empty set is WorkNone — the turn called nothing.
//
// It is exported so the classification has exactly one definition, testable on
// its own and shared by the summary and any future caller. The precedence is
// applied here and nowhere else.
func WorkKindOfTurn(tools []string) WorkKind {
	if len(tools) == 0 {
		return WorkNone
	}
	best := WorkOther
	bestRank := workKindRank(WorkOther)
	for _, t := range tools {
		k := workKindOf(t)
		if r := workKindRank(k); r < bestRank {
			best, bestRank = k, r
		}
	}
	return best
}

// workKindOrder is the order rows are BUILT in, so a given set of categories
// always produces the same slice regardless of map iteration order. It is the
// precedence order, which makes the construction deterministic; the rows are
// then sorted by cost before they are returned.
//
// Sorted by cost, not left in category order, because this panel sits between
// the model mix and the project list — both ranked by cost, both labelled "by
// cost" — and answers the same question they do. A reader scanning the Cost
// screen for the largest driver should find it in the first row of every panel,
// not have to read seven rows of a fixed list to discover which is biggest. The
// categories remain a fixed, stated set whatever order they are shown in; the
// rule that defines them (WorkKindRule) is what must not move, and it does not.
var workKindOrder = []WorkKind{WorkEdit, WorkCommand, WorkRead, WorkWeb, WorkMCP, WorkOther, WorkNone}

// workSpend aggregates spend by the kind of work each turn did, from the turns
// the carry-forward scan has already read.
//
// NO QUERY OF ITS OWN. The rows this needs — every assistant turn in range,
// each already carrying its cost and the kind decided from its own tool calls —
// are exactly the rows turnSpendBySession scans for per-directory attribution.
// Running a second aggregate over the same events measured 292 ms on the
// owner's database against a ~30 ms budget for the whole feature (2026-08-23,
// 30d, Go driver), so the classification rides along in that scan instead and
// this function is arithmetic on the result.
//
// WHAT THE "no tool" ROW HONESTLY CONTAINS. A turn with no linked tool call is
// either a turn that genuinely called nothing, or a turn whose tool calls exist
// but were never linked to it. Nothing in the row distinguishes them, so the
// count returned here is the size of that whole ambiguous bucket — NOT a claim
// that those turns were unlinked. It is what the UI needs in order to say
// "these turns called no tool that Caprock could see", which is the strongest
// statement the data supports.
//
// The linkage is normally complete: on the owner's database 99.97% of tool
// calls carry the message id that attaches them to a turn (measured
// 2026-08-23), so the bucket is overwhelmingly real no-tool turns. But the hook
// plane writes tool calls with no message id at all — the PreToolUse payload
// does not contain one — so on a database whose transcripts have been pruned
// the bucket can grow without anything else looking wrong. Publishing its size
// is what stops that from silently becoming a finding.
// The number returned beside the rows is how many TOOL CALLS in the range could
// not be attached to any turn. That is the measurable half of the ambiguity: an
// unlinkable tool call is a real call whose cost landed in the "no tool" row
// instead of its own, so the count is a direct upper bound on how wrong that
// row can be. It is a count of calls rather than of turns because a turn is
// exactly what an unlinked call has failed to identify.
func workSpend(turns map[string][]turnSpend, unlinkedCalls int64) ([]WorkShare, int64) {
	byKind := map[WorkKind]*WorkShare{}
	for _, spends := range turns {
		for _, t := range spends {
			k := WorkNone
			if t.hasWork {
				k = t.work
			}
			w := byKind[k]
			if w == nil {
				w = &WorkShare{Kind: k}
				byKind[k] = w
			}
			w.Turns++
			w.Tokens += t.tokens
			w.CostUSD += t.cost
		}
	}
	out := make([]WorkShare, 0, len(byKind))
	for _, k := range workKindOrder {
		if w := byKind[k]; w != nil {
			out = append(out, *w)
		}
	}
	// Largest first, matching the two panels this one sits beside. The sort is
	// STABLE and the input order is the fixed precedence above, so rows that
	// cost exactly the same — $0.00 rows on a quiet range, most often — keep a
	// deterministic order instead of shuffling between polls of a live
	// dashboard.
	sort.SliceStable(out, func(i, j int) bool { return out[i].CostUSD > out[j].CostUSD })
	return out, unlinkedCalls
}
