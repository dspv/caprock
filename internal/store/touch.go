package store

import (
	"context"
	"encoding/json"
	"strings"
)

// Per-directory attribution — charging a repository's spend to the directories
// inside it, so a monorepo can answer "what does /services/api cost?".
//
// WHY NOT THE SESSION'S CWD. The breakdown used to key on sessions.repo_path,
// the directory Claude was launched from. In a monorepo nobody launches Claude
// from /services/api to work on it — they open the repository root and let
// Claude edit across services. So the old rows answered "where was the
// terminal", and on the owner's database only one repository expanded at all.
// The signal people mean is which FILES were touched, which lives in the tool
// calls.
//
// THE CONSTRAINT THAT SHAPES EVERYTHING. Cost lives on turn.assistant and
// nowhere else: SUM(cost_usd) over tool.pre is exactly 0. A directory is
// therefore never charged directly — a TURN is charged, and the turn's cost
// reaches a directory only through the tool calls that turn made.
//
// CARRY-FORWARD ATTRIBUTION (the decision). A turn belongs to the directory of
// the MOST RECENT file touch at or before it, within the same session. The
// attribution carries forward until a touch in a different directory moves it.
//
// WHY, AND WHAT THE PREVIOUS RULE COST. The rule used to be strict: a turn was
// charged to a directory only when EVERY file it touched was in that one
// directory, and everything else — including every turn that touched no file at
// all — became "repository-wide work". On the owner's real data that bucket was
// 87.6% of `amarketer`'s spend. The user asked what a service costs and seven
// eighths of the answer was "we could not tell".
//
// The missing insight is that work happens in STRETCHES, not in isolated tool
// calls. The user says "finish /app", and Claude then edits a file, runs the
// tests, reads the output, greps, edits again — for an hour. That whole stretch
// is work on /app. The strict rule counted only the minutes containing a direct
// file edit and discarded the rest, which is why Bash-heavy turns (half of all
// tool calls) fell out.
//
// WHY THIS IS NOT AN INVENTED NUMBER (rule 6). No cost is split, pro-rated, or
// modelled: each turn's price goes WHOLE to exactly one row, and the rows still
// sum exactly to the repository total. What changed is the rule for deciding
// which row — a stated rule, not a guess at proportions. It is stated to the
// user in plain words wherever the breakdown is shown (TouchRule). It must
// never be described as measured file-by-file attribution, because it is not:
// the evidence is the last file touched, and a turn that ran only commands is
// placed by that evidence rather than by evidence of its own.

// TouchDirs is what one turn's attribution is decided from: the directory
// carried into it by the most recent file touch in its session.
type TouchDirs struct {
	// Dir is the absolute, normalized directory carried into this turn — the
	// directory of the most recent touch at or before it in the same session.
	// It is "" when no touch preceded the turn in its session (the session's
	// opening turns), which is the one case carry-forward cannot place.
	Dir string
	// HasDir distinguishes "no touch preceded this turn" from a directory that
	// normalized to the empty string, so the caller never treats the two alike.
	HasDir bool
}

// TouchDir extracts the directory a tool call touched from its stored payload.
//
// It returns "" when the tool named no path, which is the common case: on the
// owner's 65915 tool.pre rows, only Read, Edit, Write and Artifact carry a
// path at all. That is deliberate — see TouchRule.
func TouchDir(payload []byte) string {
	p := touchPathOf(payload)
	if p == "" {
		return ""
	}
	return dirOf(p)
}

// TouchRule is the statement of how a turn is placed, shown in the UI so the
// number is not a black box. It is the sentence that makes this honest rather
// than a guess, so it says exactly what the rule does and claims nothing more.
//
// THE RULE, in the user's words: a turn counts toward the directory of the most
// recent file it touched, and work keeps counting there until it touches a file
// somewhere else.
//
// Why a stretch and not a single call. Work happens in stretches: after "finish
// /app", Claude edits, runs the tests, reads the output, greps, edits again.
// Charging only the calls that name a file would count the edit and discard the
// hour around it.
//
// What counts as touching. A tool that names a FILE — Read, Edit, Write,
// NotebookEdit. Bash does not, even when its command contains a path:
// `grep -r foo /services` reads a tree and `cd /services/api && go build ./...`
// names one directory while touching many, so parsing intent out of a command
// line would be inference presented as measurement. Under carry-forward that
// costs nothing, because a Bash turn is placed by the file touched before it
// rather than dropped.
//
// Why reading counts. Reading a file to understand it is how most of a turn's
// tokens get spent — the contents enter the prompt and are billed.
const TouchRule = "A turn counts toward the directory of the most recent file it touched; work continues to count there until it touches a file somewhere else. Reading, editing or writing a file counts as touching it; running a command does not, so the commands, tests and searches between two edits count toward the directory being worked on. Each turn's cost goes whole to one directory — never split between them — so the rows add up to the repository total exactly."

// touchPathOf pulls the file path a tool call names out of its payload.
//
// tool_input is not always an object: the hook plane sometimes stores it as a
// STRING (a Python-repr of the input), and a truncated payload replaces it with
// a marker object. Both are treated as "no path" rather than parsed
// heuristically.
func touchPathOf(payload []byte) string {
	if len(payload) == 0 {
		return ""
	}
	var p struct {
		ToolInput json.RawMessage `json:"tool_input"`
	}
	if err := json.Unmarshal(payload, &p); err != nil || len(p.ToolInput) == 0 {
		return ""
	}
	var in struct {
		FilePath string `json:"file_path"`
		// notebook_path is NotebookEdit's spelling of the same idea. It does not
		// appear on the owner's database, but the tool exists and costs nothing
		// to honour.
		NotebookPath string `json:"notebook_path"`
	}
	if err := json.Unmarshal(p.ToolInput, &in); err != nil {
		return "" // a string or otherwise non-object tool_input
	}
	if in.FilePath != "" {
		return in.FilePath
	}
	return in.NotebookPath
}

// dirOf returns the directory containing an absolute file path, normalized to
// the shape the rest of the grouping assumes (forward slashes, no trailing
// separator).
//
// It uses the SAME normalization as repository resolution (normalizeCwd), so a
// touched path and a repository root are comparable regardless of which host
// captured them. This matters on Windows, where paths arrive with backslashes
// and one database routinely holds both shapes.
//
// A relative path is refused rather than resolved: the cwd it would be relative
// to is the session's, and joining them would invent a location the tool never
// named.
func dirOf(p string) string {
	p = normalizeCwd(p)
	if p == "" || isRootPath(p) {
		return ""
	}
	i := strings.LastIndexByte(p, '/')
	if i < 0 {
		return "" // a bare filename: no directory was named
	}
	if i == 0 {
		return "/" // a file directly under the filesystem root
	}
	dir := p[:i]
	if isRootPath(dir + "/") {
		return dir + "/" // a drive root, "C:/"
	}
	return dir
}

// AttributeDir decides which row a turn's cost belongs to, given the directory
// carried into it and the repository the turn's session sits in.
//
// It always returns a row, because every turn's cost belongs somewhere and the
// rows must sum to the repository total. There are exactly three outcomes:
//
//   - a directory inside the repository, written relative to its root
//   - OutsidePath, when the carried directory is real but not in this
//     repository
//   - UnattributedPath, when no touch preceded this turn in its session
//
// PATHS OUTSIDE THE REPOSITORY get their own row rather than being folded into
// the repository root or dropped. Folding them into "/" would claim work
// happened in the checkout when it did not; dropping them would stop the parts
// reconciling with the total. On the owner's database this is not a rounding
// error — it is 25.8% of `amarketer` and 28.7% of `caprock` (measured
// 2026-08-22) — and it is overwhelmingly work ON this project whose files live
// elsewhere: Claude's own notes under ~/.claude/projects/<project>/memory,
// subagent scratchpads under the per-session temp directory, and test output
// directories. A share that large must be named, not hidden.
//
// It deliberately does NOT try to tell "another checkout" from "scratch space".
// The only way to do so would be to ask whether the path sits under some OTHER
// repository root the database happens to know, and that answer is unstable:
// `caprock-web` is a real git repository on disk that no session was ever
// launched from, so it is invisible here — the same path would classify one way
// today and another tomorrow, silently moving money between rows. One
// structural question ("is it inside THIS repository?") is answerable from the
// two paths alone and always gives the same answer.
//
// TURNS BEFORE ANY TOUCH land in UnattributedPath rather than carrying BACKWARD
// from the session's first touch. Measured both ways on the owner's database
// (2026-08-22, all time): carrying backward moves $2.39 of $3426 in `amarketer`
// and $11.45 of $1729 in `caprock` — 0.1% and 0.7%. That is far too little to
// justify a second rule pointing the opposite way, which would make the
// one-sentence explanation two sentences and let a session's opening question
// charge a directory it had not reached yet.
func AttributeDir(t TouchDirs, repoRoot string) (string, bool) {
	if !t.HasDir {
		return UnattributedPath, true
	}
	if repoRoot == "" || !hasPathPrefix(t.Dir, repoRoot) {
		return OutsidePath, true
	}
	return RepoInfo{Path: relativeUnder(repoRoot, t.Dir)}.Segment(), true
}

// UnattributedPath is the sentinel for the turns carry-forward cannot place:
// those that ran before any file was touched in their session.
//
// It is a sentinel, not a path, and it must never reach a user as one: the UI
// renders it as "repository-wide work" in its own style with the reason
// attached. It starts with a character no path segment does so that a
// hypothetical directory of the same name could not collide with it.
//
// WHAT NOW LANDS HERE, AND WHY THE ROW IS SMALL. Under the previous strict rule
// this bucket was most of the money — 87.6% of the owner's `amarketer` — and
// the UI had to work hard to explain that it was not a failure. Under
// carry-forward it means one narrow, honest thing: a session's opening turns,
// before Claude has touched any file. On the owner's database that is $2.39 of
// $3426 in `amarketer` and $11.45 of $1729 in `caprock` (measured 2026-08-22).
// It is usually zero, and the UI must not render an empty row.
const UnattributedPath = "\x00unattributed"

// OutsidePath is the sentinel for turns whose carried directory is real but
// sits outside the repository — Claude's notes about the project, subagent
// scratchpads, test-output directories, or another checkout entirely.
//
// It is a row of its own, sibling to the directory rows and to
// UnattributedPath, because it is neither: the work has a known location and
// that location is simply not in this tree. Merging it into repository-wide
// work would mislabel a quarter of the bill as "no single home" when its home
// is known and named; folding it into the repository root would claim work
// happened in the checkout that did not. See AttributeDir for the measured
// shares and for why "another checkout" is not split out separately.
const OutsidePath = "\x00outside"

// turnSpendBySession returns, per session, one entry per assistant turn in the
// range: what it cost and which directory was carried into it.
//
// ONE ORDERED SCAN, NOT A JOIN. Carry-forward is inherently sequential — a
// turn's directory is a function of everything before it in its session — so
// the tool calls and the turns are read TOGETHER in event order and the carry
// is threaded through them in Go. This replaces the two independent queries the
// strict rule used (a per-turn touch lookup plus a turn scan).
//
// Doing the carry in SQL was considered and rejected. A window function could
// compute `last_value(touch_dir) IGNORE NULLS OVER (PARTITION BY session_id
// ORDER BY ts, id)`, but deciding whether the carried directory is inside the
// repository needs the same path normalization the ingest path uses — folding
// separators so a Windows-captured session groups with the same repository read
// anywhere else. Re-implementing that in SQL would put a second, silently
// diverging definition in a second language, the exact trap migration 0012
// documents for the dirname cut. The scan is O(n) in one pass either way.
//
// WHY msg_id NO LONGER GATES ATTRIBUTION. Under the strict rule a tool call
// without a message id could not be billed to a turn, so its whole session was
// forced unattributed. Carry-forward does not need the linkage: it places a
// turn by WHEN a touch happened relative to it, not by which message the touch
// belonged to. A hook-plane tool call carries no msg_id but does carry a
// timestamp, which is all the carry needs — so those sessions now attribute
// normally instead of collapsing into one bucket.
//
// COST IS READ, NOT RECOMPUTED. cost_usd on turn.assistant is the priced figure
// the rest of the dashboard reports; deriving a second number here would give
// the panel two totals for one repository.
//
// INDEXED BY is not a micro-optimization. Without stats — and nothing in the
// daemon runs ANALYZE, so no user database has them — SQLite prefers
// idx_events_kind_ts for the `kind IN (…)` predicate and sorts 90271 rows in a
// temp B-tree: ~290 ms, against a ~250 ms budget for the whole summary. Pinning
// idx_events_attr makes the plan a covering scan in index order with no sort,
// measured at ~93 ms on the owner's database (2026-08-22, 30d, Go driver).
// It also returns how many tool calls in the range carried no message id and so
// could not be attached to any turn — the honest upper bound on how much of the
// work-kind breakdown's "no tool" row is really unlinked work (see workkind.go).
func turnSpendBySession(ctx context.Context, q Querier, fromMs int64) (map[string][]turnSpend, int64, error) {
	// msg_id and tool ride along for the WORK-KIND breakdown, which needs
	// exactly the rows this scan already reads (see workkind.go). Folding it in
	// here rather than running a second aggregate is what keeps it free: the
	// index covers every column below, so the plan stays a covering scan in
	// index order with no sort and no table access.
	rows, err := q.QueryContext(ctx, `
		SELECT session_id, kind, COALESCE(touch_dir, ''), COALESCE(msg_id,''), COALESCE(tool,''),
		       COALESCE(tokens_in,0)+COALESCE(tokens_out,0)+COALESCE(cache_read,0)+COALESCE(cache_write,0),
		       COALESCE(cost_usd,0)
		FROM events INDEXED BY idx_events_attr_work
		WHERE session_id IS NOT NULL AND ts >= ?
		  AND kind IN ('tool.pre', 'turn.assistant')
		ORDER BY session_id, ts, id`, fromMs)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := map[string][]turnSpend{}
	// Tool calls in range with no message id: they exist, they were paid for,
	// and nothing says which turn paid. Counted so the breakdown can state its
	// own uncertainty instead of presenting it as absence of tool use.
	var unlinkedCalls int64
	// The work kind of each turn, keyed by its message id. A turn is classified
	// by its OWN tool calls, so this is a plain grouping rather than a carry —
	// see workkind.go for why work kind must not carry forward the way a
	// directory does.
	//
	// The key is the bare message id, not (session, message id): the scan is
	// ordered by session, so the map is CLEARED on every session change and can
	// never be consulted across one. That keeps a string concatenation out of
	// the hot path — this loop runs once per tool call on the whole range.
	kinds := map[string]WorkKind{}
	// The carry, valid only within the session named by carrySess. Resetting it
	// on every session change is what keeps attribution from crossing session
	// boundaries — one piece of work must never be charged to another's
	// directory, and the scan's ORDER BY groups sessions so a single variable
	// suffices.
	var carrySess, carryDir string
	var carried bool
	for rows.Next() {
		var sess, kind, dir, msg, tool string
		var tokens int64
		var cost float64
		if err := rows.Scan(&sess, &kind, &dir, &msg, &tool, &tokens, &cost); err != nil {
			return nil, 0, err
		}
		if sess != carrySess {
			// Resolve the OUTGOING session's turns before its message ids are
			// forgotten. A turn's row is written BEFORE the tool_use blocks of
			// the same message (they arrive on a later transcript line), so a
			// turn's own tool calls are still ahead of it when its row is read
			// — the kinds cannot be applied until the session is complete.
			// carrySess still names the outgoing session at this point.
			resolveWork(out[carrySess], kinds)
			clear(kinds)
			carrySess, carryDir, carried = sess, "", false
		}
		if kind == "tool.pre" {
			// The work kind of the TURN this call belongs to, keyed by the
			// message id that links them. A call with no message id cannot be
			// attached to any turn and is counted rather than guessed at —
			// that count is Summary.WorkUnlinkedCalls.
			if msg == "" {
				unlinkedCalls++
			} else {
				k := workKindOf(tool)
				if cur, seen := kinds[msg]; !seen || workKindRank(k) < workKindRank(cur) {
					kinds[msg] = k
				}
			}
			// Only a tool that named a file moves the carry. A pathless call
			// (Bash, Grep) leaves touch_dir NULL and must NOT clear it — the
			// commands between two edits are part of the same stretch of work,
			// which is the whole point of the rule.
			if dir != "" {
				carryDir, carried = dir, true
			}
			continue
		}
		ts := turnSpend{
			tokens:  tokens,
			cost:    cost,
			touched: TouchDirs{Dir: carryDir, HasDir: carried},
			msgKey:  msg,
			hasMsg:  msg != "",
		}
		out[sess] = append(out[sess], ts)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	// The final session has no successor to trigger its resolution.
	resolveWork(out[carrySess], kinds)
	return out, unlinkedCalls, nil
}

// resolveWork stamps each turn with the kind decided from its own tool calls.
// It runs per session, once that session's rows are all read.
func resolveWork(spends []turnSpend, kinds map[string]WorkKind) {
	for i := range spends {
		s := &spends[i]
		if !s.hasMsg {
			continue
		}
		if k, ok := kinds[s.msgKey]; ok {
			s.work, s.hasWork = k, true
		}
	}
}
