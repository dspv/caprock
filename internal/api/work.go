package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/dspv/caprock/internal/store"
)

// The Work board (ADR-064, 03-contracts.md § Work): across every live
// session on the machine, what is being worked on, by whom, at what cost,
// what is planned next and what waits to be released. Composed per request
// from what Caprock already records and from local git; nothing is written
// and GitHub is never asked — the pull request stages come from the
// Pipeline's own board (GET /v1/repos/ci), which the screen joins by branch.

// Work session states.
const (
	WorkWorking    = "working"
	WorkPermission = "permission"
	WorkQuestion   = "question"
	WorkAtPrompt   = "at_prompt"
	// WorkBackground: the turn ended and subagents it started still work;
	// the session wants nothing from anyone.
	WorkBackground = "background"
)

// How a session is tied to a pull request.
const (
	// LinkRecorded: the session's own `gh pr` commands named the pull
	// request (session_prs).
	LinkRecorded = "recorded"
	// LinkBranch: the session works on a branch other than the default; a
	// pull request whose head is that branch is its.
	LinkBranch = "branch"
	LinkNone   = "none"
)

// Work is GET /v1/work.
type Work struct {
	// Now is the daemon's clock (unix ms); every ETA counts from it.
	Now int64 `json:"now"`
	// DayStart is the local midnight today's figures count from (unix ms).
	DayStart int64         `json:"day_start"`
	Sessions []WorkSession `json:"sessions"`
	// Tasks are the task runner's tasks; absent when the runner is off.
	Tasks  []WorkTask   `json:"tasks,omitempty"`
	Hive   string       `json:"hive"` // on | off
	Queued []WorkQueued `json:"queued"`
	Repos  []WorkRepo   `json:"repos"`
	Totals WorkTotals   `json:"totals"`
}

// WorkSession is one live session (shells are not sessions).
type WorkSession struct {
	SessionID string `json:"session_id"`
	Agent     string `json:"agent"`
	// Owned: Caprock started it.
	Owned        bool   `json:"owned"`
	Model        string `json:"model,omitempty"`
	ModelDisplay string `json:"model_display,omitempty"`
	Subscription string `json:"subscription,omitempty"`
	Name         string `json:"name,omitempty"`
	// Description and DescriptionSource as on the session list.
	Description       string `json:"description,omitempty"`
	DescriptionSource string `json:"description_source,omitempty"`
	Project           string `json:"project"`
	RepoRoot          string `json:"repo_root,omitempty"`
	Worktree          string `json:"worktree,omitempty"`
	Branch            string `json:"branch,omitempty"`
	// OnDefault: Branch is the repository's default branch, as the clone
	// knows it. Absent when either is unknown.
	OnDefault *bool  `json:"on_default,omitempty"`
	StartedAt int64  `json:"started_at"`
	WorkedAt  int64  `json:"worked_at,omitempty"`
	State     string `json:"state"`
	// TurnStartedAt is when the running turn's prompt was sent (unix ms).
	TurnStartedAt int64 `json:"turn_started_at,omitempty"`
	// TurnLeft is the running turn's remaining time, from the project's
	// finished turns (the Queue's estimate); only while it works.
	TurnLeft     *ETA       `json:"turn_left,omitempty"`
	Estimate     *Estimate  `json:"estimate,omitempty"`
	EstimateNote string     `json:"estimate_note,omitempty"`
	Todo         *BoardTodo `json:"todo,omitempty"`
	CostUSD      float64    `json:"cost_usd"`
	TodayUSD     float64    `json:"today_usd"`
	// PRs are the pull requests the session's own commands opened or
	// merged, newest four.
	PRs      []WorkPR `json:"prs"`
	Link     string   `json:"link"`
	LinkNote string   `json:"link_note,omitempty"`
}

// WorkPR is one recorded pull request.
type WorkPR struct {
	Number   int    `json:"number"`
	URL      string `json:"url"`
	Title    string `json:"title,omitempty"`
	OpenedAt int64  `json:"opened_at,omitempty"`
	MergedAt int64  `json:"merged_at,omitempty"`
}

// WorkTask is one of the task runner's tasks.
type WorkTask struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Status    string  `json:"status"`
	SessionID string  `json:"session_id,omitempty"`
	Branch    string  `json:"branch,omitempty"`
	BudgetUSD float64 `json:"budget_usd"`
	SpentUSD  float64 `json:"spent_usd"`
}

// WorkQueued is a message waiting in an owned session's queue.
type WorkQueued struct {
	SessionID string `json:"session_id"`
	Position  int    `json:"position"`
	// Text is clipped to 200 runes.
	Text   string `json:"text"`
	Start  *ETA   `json:"start,omitempty"`
	Finish *ETA   `json:"finish,omitempty"`
}

// WorkRepo is a repository a live or recent session works in.
type WorkRepo struct {
	Root string `json:"root"`
	Name string `json:"name"`
	// Remote is "owner/name" from its remote's web address.
	Remote string `json:"remote,omitempty"`
	// ViaSession is the newest session that brought the repository here.
	ViaSession string `json:"via_session"`
	// Live counts its live sessions.
	Live       int             `json:"live"`
	Unreleased *WorkUnreleased `json:"unreleased,omitempty"`
	Tags       *WorkTags       `json:"tags,omitempty"`
	// AheadOfTag is how many commits the default branch has past the last
	// tag, as of the last fetch.
	AheadOfTag *int `json:"ahead_of_tag,omitempty"`
}

// WorkUnreleased is the CHANGELOG's [Unreleased] section on the remote's
// default branch, as of the last fetch.
type WorkUnreleased struct {
	// Ref is the branch it was read from, "origin/main".
	Ref string `json:"ref"`
	// Items are its top-level entries' first lines, at most 30.
	Items []string `json:"items"`
	Count int      `json:"count"`
	// More: Count is larger than Items.
	More bool `json:"more,omitempty"`
}

// WorkTags is the newest tags, read locally.
type WorkTags struct {
	Last *WorkTag `json:"last,omitempty"`
	// GapMedianMs is the median time between the newest (up to eleven)
	// tags; absent with fewer than three gaps.
	GapMedianMs int64 `json:"gap_median_ms,omitempty"`
	Gaps        int   `json:"gaps"`
}

// WorkTag is one tag.
type WorkTag struct {
	Name string `json:"name"`
	At   int64  `json:"at"`
}

// WorkTotals sums the board up.
type WorkTotals struct {
	Live       int `json:"live"`
	Working    int `json:"working"`
	WaitingYou int `json:"waiting_you"`
	// TodayUSD sums the live sessions' today_usd; MachineTodayUSD is every
	// session's since DayStart.
	TodayUSD        float64 `json:"today_usd"`
	MachineTodayUSD float64 `json:"machine_today_usd"`
}

// WorkBoarder assembles the Work board. Optional on Deps: nil answers 501.
type WorkBoarder interface {
	Work(ctx context.Context) (Work, error)
}

// handleWork is GET /v1/work.
func (s *Server) handleWork(w http.ResponseWriter, r *http.Request) {
	if s.d.Work == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this daemon has no work board"))
		return
	}
	b, err := s.d.Work.Work(r.Context())
	if err != nil {
		s.failCode(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, b)
}

// DescribeWithSource is Describe and where the text came from (name, title
// or prompt), for a daemon-side view that styles a guess apart from a name.
func DescribeWithSource(ctx context.Context, q store.Querier, sess store.Session) (text, source string) {
	return describe(ctx, q, sess)
}
