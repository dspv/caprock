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
// STRICT ATTRIBUTION (the decision). A turn's cost is charged to a directory
// only when EVERY path that turn touched is in that one directory. A turn that
// spans several directories is not split, pro-rated, or assigned to the biggest
// share — its cost goes whole into an explicitly labelled bucket. This trades
// completeness for exactness: every per-directory figure on screen is measured,
// and the parts still sum to the repository's total, so nothing is hidden and
// nothing is invented (rule 6). Splitting would require a model of how much of
// a turn each file deserved, and no such measurement exists.

// TouchDirs is the set of directories one turn touched, and whether anything
// about that set is unknown.
type TouchDirs struct {
	// Dirs are the distinct absolute directories touched, normalized.
	Dirs map[string]struct{}
	// Unlinkable records that at least one tool call could not be tied to a
	// turn (no message id — the hook plane never supplies one). Such a turn is
	// reported as unattributed rather than attributed on partial evidence.
	Unlinkable bool
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

// TouchRule is the one-sentence statement of what counts as touching a
// directory, shown in the UI so the number is not a black box.
//
// THE RULE: a tool that names a FILE touches that file's directory. Read, Edit
// and Write do; Bash, Grep and Glob do not.
//
// Why reading counts. Reading a file to understand it is how most of a turn's
// tokens get spent — the file's contents enter the prompt and are billed. A
// rule that counted only writes would report a directory as free right up to
// the moment it was edited, which is the opposite of what a budget wants to
// know.
//
// Why Bash does not, even when its command contains a path. A path inside a
// shell string is not a claim about what was touched: `grep -r foo /services`
// reads a tree, `cd /services/api && go build ./...` names one directory and
// touches many, and `rm /tmp/x` names a path that is not work at all. Parsing
// intent out of a command line would be inference presented as measurement.
// Bash is the biggest tool by volume on the owner's database (32581 of 65915
// calls), so this is not a rounding decision — it is the reason a large share
// of spend lands in the unattributed bucket, and the UI says so rather than
// quietly redistributing it.
//
// Why not Grep and Glob. They name a search pattern and a root, not a file that
// was read; the files they matched are not recorded. Neither appears at all on
// the owner's database, so including them would add no signal and one more
// assumption.
const TouchRule = "A turn is charged to a directory only when every file it read or wrote is in that directory. Tools that name a file (Read, Edit, Write) attribute; Bash, Grep and Glob do not — a path inside a shell command is not a record of what was touched. Everything else is repository-wide work: turns that ran commands, searched, or built rather than editing files in one place."

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

// AttributeDir decides which directory a turn's cost belongs to, given every
// directory its tool calls touched and the repository the turn's session sits
// in.
//
// It returns the directory to charge and true, or false when the turn cannot be
// charged to exactly one. The three unattributable cases are deliberately not
// distinguished here — they are all "we do not know which one directory this
// was", and the UI states them as one honest bucket:
//
//   - the turn touched several directories (do not split — see the file header)
//   - the turn touched nothing that names a path (a pure Bash or thinking turn)
//   - the turn touched a path OUTSIDE the repository
//
// FILES OUTSIDE THE REPOSITORY. A turn that edits /tmp, or a file in an
// entirely different checkout, is not charged to the repository's directories —
// the touched directory is not one of them, so claiming it would put spend
// under a heading it does not belong to. Such a turn still counts toward the
// repository total (its session is in this repository and the money was really
// spent there), and lands in the unattributed bucket. That keeps the parts
// summing to the whole without inventing a row for a directory the repository
// does not contain.
func AttributeDir(t TouchDirs, repoRoot string) (string, bool) {
	if t.Unlinkable || len(t.Dirs) != 1 {
		return "", false
	}
	var only string
	for d := range t.Dirs {
		only = d
	}
	if repoRoot == "" {
		return "", false
	}
	if !hasPathPrefix(only, repoRoot) {
		return "", false // outside this repository
	}
	return RepoInfo{Path: relativeUnder(repoRoot, only)}.Segment(), true
}

// UnattributedPath is the sentinel for spend that belongs to a repository but
// not to any single directory inside it.
//
// It is a sentinel, not a path, and it must never reach a user as one: the UI
// renders it as "repository-wide work" in its own style with the reason
// attached. It starts with a character no path segment does so that a
// hypothetical directory of the same name could not collide with it.
//
// THE NAME IS INTERNAL ONLY. "Unattributed" describes this package's
// bookkeeping, not the user's work, and on real data this row is usually the
// largest — the tool calls behind it are overwhelmingly Bash (17382 of 27158
// calls in the owner's `amarketer`, measured 2026-08-22): test runs, `git log`,
// tree-wide greps, builds. Showing a user that word next to two thirds of their
// spend says the tool failed, when in fact the work simply has no one home. The
// UI therefore names what the work IS; see REPO_WIDE_LABEL in Projects.tsx.
const UnattributedPath = "\x00unattributed"

// turnTouch is the accumulating state for one turn while its tool calls are
// read.
type turnTouch struct {
	dirs       map[string]struct{}
	unlinkable bool
}

// TouchesByTurn reads every tool call in a time range and returns, per session,
// the set of directories each TURN touched — keyed by the message id that links
// the tool call to the turn whose cost paid for it.
//
// The query reads only indexed columns (kind, ts, session_id, msg_id,
// touch_dir) and never parses JSON, which is the whole point of resolving
// touch_dir at ingest: on the owner's database json_extract over the tool.pre
// rows in a 30-day range costs ~215ms against a ~152ms budget for the entire
// summary.
//
// A tool.pre row with no msg_id cannot be tied to a turn (the hook plane does
// not carry one). Those rows are counted per session so their sessions can be
// reported as partially unattributed rather than silently attributed on the
// evidence that happens to be linkable.
func TouchesByTurn(ctx context.Context, q Querier, fromMs int64) (map[string]map[string]TouchDirs, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT session_id, COALESCE(msg_id, ''), touch_dir
		FROM events
		WHERE kind = 'tool.pre' AND ts >= ? AND touch_dir IS NOT NULL`, fromMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]turnTouch{}
	for rows.Next() {
		var sess, msg, dir string
		if err := rows.Scan(&sess, &msg, &dir); err != nil {
			return nil, err
		}
		bySess := out[sess]
		if bySess == nil {
			bySess = map[string]turnTouch{}
			out[sess] = bySess
		}
		if msg == "" {
			// Unlinkable: a touch we know happened but cannot bill to a turn.
			// It is recorded against the session under the empty key so the
			// session's spend is not quietly attributed as if this had not
			// happened.
			t := bySess[""]
			t.unlinkable = true
			bySess[""] = t
			continue
		}
		t := bySess[msg]
		if t.dirs == nil {
			t.dirs = map[string]struct{}{}
		}
		t.dirs[dir] = struct{}{}
		bySess[msg] = t
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	res := make(map[string]map[string]TouchDirs, len(out))
	for sess, byMsg := range out {
		m := make(map[string]TouchDirs, len(byMsg))
		for msg, t := range byMsg {
			m[msg] = TouchDirs{Dirs: t.dirs, Unlinkable: t.unlinkable}
		}
		res[sess] = m
	}
	return res, nil
}

// turnSpendBySession returns, per session, one entry per assistant turn in the
// range: what it cost and which directories it touched.
//
// Turns are keyed by msg_id, the same id that links a tool call to the turn
// that paid for it. A turn with no msg_id (a transcript line that carried no
// message id) is kept under a per-turn synthetic key so its spend still reaches
// the repository total — it simply has no tools to attribute it by, and lands
// in the unattributed bucket.
//
// COST IS READ, NOT RECOMPUTED. cost_usd on turn.assistant is the priced figure
// the rest of the dashboard reports; deriving a second number here would give
// the panel two totals for one repository.
func turnSpendBySession(ctx context.Context, q Querier, fromMs int64) (map[string][]turnSpend, error) {
	touches, err := TouchesByTurn(ctx, q, fromMs)
	if err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `
		SELECT session_id, COALESCE(msg_id, ''), id,
		       COALESCE(tokens_in,0)+COALESCE(tokens_out,0)+COALESCE(cache_read,0)+COALESCE(cache_write,0),
		       COALESCE(cost_usd,0)
		FROM events
		WHERE kind = 'turn.assistant' AND ts >= ?`, fromMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]turnSpend{}
	for rows.Next() {
		var sess, msg string
		var id, tokens int64
		var cost float64
		if err := rows.Scan(&sess, &msg, &id, &tokens, &cost); err != nil {
			return nil, err
		}
		ts := turnSpend{tokens: tokens, cost: cost}
		if msg != "" {
			ts.touched = touches[sess][msg]
		}
		// A session with an unlinkable tool call cannot be sure any of its
		// turns is complete: the touch that was lost might belong to this one
		// and might be in another directory. Marking the turn unlinkable makes
		// it unattributed rather than attributed on evidence known to be
		// partial — the strict rule applied to its own blind spot.
		if u, ok := touches[sess][""]; ok && u.Unlinkable {
			ts.touched.Unlinkable = true
		}
		out[sess] = append(out[sess], ts)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
