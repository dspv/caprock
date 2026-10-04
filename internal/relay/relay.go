// Package relay builds the brief that carries a session's work into a new
// session, possibly in another agent.
//
// A relay is not a continuation: the new session does not have the old one's
// conversation, only what this brief tells it. So the brief is built from what
// Caprock already holds, locally, and shown to the user to read and edit before
// it is sent — it is the user's first message, not something slipped in.
//
// What goes in, and why:
//
//   - The last substantial passage the session's agent wrote. Recency, not a
//     search: measured for the SessionStart handoff (internal/daemon/handoff.go)
//     on the owner's database, the last passage answered "where were we" in 12
//     of 19 cases against 4 of 15 for a term search. A relay asks the same
//     question.
//   - The state of the working tree, from the same diff the Diff panel shows
//     (internal/gitdiff): the branch, what it changed since the trunk, and what
//     is still uncommitted. This is now, not what the session saw — the files
//     are the ground truth the new session will work on.
//   - The pull requests the session opened, from Claude Code's own record of
//     them (the `gitOperation.pr` it attaches to a Bash result). Other agents
//     do not record one, so their PRs are not listed rather than guessed from
//     command text.
package relay

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/gitdiff"
	"github.com/dspv/caprock/internal/store"
)

const (
	// PassageMaxRunes bounds the passage. Longer than the SessionStart
	// handoff's 1200, because here the user reads it first and can cut it,
	// and the passage is most of what the new session knows.
	PassageMaxRunes = 2400
	// PassageMinRunes is the floor for a passage worth relaying, the same as
	// the handoff's: "Done." says nothing about where the work stood. When
	// the session never wrote one that long, its last passage is used anyway.
	PassageMinRunes = 400
	// MaxFiles is how many changed files are listed by name.
	MaxFiles = 25
	// MaxPromptRunes is the largest brief a spawn accepts, edits included.
	MaxPromptRunes = 8000
)

// PR is one pull request a session opened.
type PR struct {
	Number int    `json:"number"`
	URL    string `json:"url"`
}

// Git is the summary of the working tree.
type Git struct {
	Branch string `json:"branch,omitempty"`
	// Base is what the changes are measured against ("since master"), empty
	// for HEAD.
	Base    string   `json:"base,omitempty"`
	Files   []string `json:"files"`
	More    int      `json:"more,omitempty"`
	Stat    string   `json:"stat,omitempty"`
	NotRepo bool     `json:"not_repo,omitempty"`
}

// Brief is everything the relay dialog shows, and the text it proposes.
type Brief struct {
	SessionID string `json:"session_id"`
	Agent     string `json:"agent"`
	Cwd       string `json:"cwd"`
	// CwdExists is false when the folder is gone; the new session then has
	// nowhere to start.
	CwdExists bool `json:"cwd_exists"`
	// PassageAt is when the relayed passage was written (unix ms), 0 when the
	// session left none.
	PassageAt int64  `json:"passage_at,omitempty"`
	Git       *Git   `json:"git,omitempty"`
	PRs       []PR   `json:"prs"`
	Text      string `json:"text"`
}

// Build assembles the brief for a session. Nothing leaves the machine: the
// passage and the PRs are rows Caprock holds, and the diff is a local git call.
func Build(ctx context.Context, q store.Querier, sess store.Session, now time.Time) (Brief, error) {
	b := Brief{SessionID: sess.SessionID, Agent: sess.Agent, Cwd: sess.Cwd, PRs: []PR{}}
	if b.Agent == "" {
		b.Agent = "claude"
	}
	if fi, err := os.Stat(sess.Cwd); err == nil && fi.IsDir() && sess.Cwd != "" {
		b.CwdExists = true
	}

	notes, err := store.SessionNotes(ctx, q, sess.SessionID, 200)
	if err != nil {
		return Brief{}, err
	}
	passage := lastPassage(notes)

	if b.CwdExists {
		b.Git = gitSummary(ctx, sess.Cwd)
	}
	prs, err := PullRequests(ctx, q, sess.SessionID)
	if err != nil {
		return Brief{}, err
	}
	b.PRs = prs

	var age time.Duration
	if passage != nil {
		b.PassageAt = passage.Ts
		age = now.Sub(time.UnixMilli(passage.Ts))
	}
	b.Text = compose(b, passage, age, sess.GitBranch)
	return b, nil
}

// lastPassage is the newest passage long enough to say where the work stood,
// or the newest of all when none is. notes are newest first.
func lastPassage(notes []store.AssistantNote) *store.AssistantNote {
	for i := range notes {
		if utf8.RuneCountInString(strings.TrimSpace(notes[i].Text)) >= PassageMinRunes {
			return &notes[i]
		}
	}
	for i := range notes {
		if strings.TrimSpace(notes[i].Text) != "" {
			return &notes[i]
		}
	}
	return nil
}

func gitSummary(ctx context.Context, cwd string) *Git {
	res, err := gitdiff.Diff(ctx, cwd)
	if err != nil {
		return &Git{NotRepo: true, Files: []string{}}
	}
	g := &Git{Branch: res.Branch, Base: res.Base, Files: []string{}}
	for i, f := range res.Files {
		if i >= MaxFiles {
			g.More = len(res.Files) - MaxFiles
			break
		}
		line := f.Status + " " + f.Path
		if !f.Binary && (f.Additions > 0 || f.Deletions > 0) {
			line += fmt.Sprintf(" (+%d -%d)", f.Additions, f.Deletions)
		}
		g.Files = append(g.Files, line)
	}
	// The last line of --stat is the totals ("3 files changed, …").
	if lines := strings.Split(strings.TrimSpace(res.Stat), "\n"); len(lines) > 0 {
		g.Stat = strings.TrimSpace(lines[len(lines)-1])
	}
	return g
}

// PullRequests lists the PRs a session opened, oldest first, from Claude
// Code's own record on its Bash results (`tool_response.gitOperation.pr`,
// action "created"). Subagents' are included: the session opened them too.
func PullRequests(ctx context.Context, q store.Querier, sessionID string) ([]PR, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT CAST(COALESCE(json_extract(payload, '$.tool_response.gitOperation.pr.number'), 0) AS INTEGER),
		       COALESCE(json_extract(payload, '$.tool_response.gitOperation.pr.url'), '')
		FROM events
		WHERE session_id = ? AND kind = 'tool.post'
		  AND json_extract(payload, '$.tool_response.gitOperation.pr.action') = 'created'
		ORDER BY ts`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PR{}
	seen := map[string]bool{}
	for rows.Next() {
		var p PR
		if err := rows.Scan(&p.Number, &p.URL); err != nil {
			return nil, err
		}
		if p.URL == "" || seen[p.URL] {
			continue
		}
		seen[p.URL] = true
		out = append(out, p)
	}
	return out, rows.Err()
}

// AgentName is how the brief and the dialog name an agent.
func AgentName(agent string) string {
	switch agent {
	case "codex":
		return "Codex"
	case "opencode":
		return "OpenCode"
	case "gemini":
		return "Gemini CLI"
	case "deepseek":
		return "DeepSeek Harness"
	default:
		return "Claude Code"
	}
}

func compose(b Brief, passage *store.AssistantNote, age time.Duration, branch string) string {
	var s strings.Builder
	fmt.Fprintf(&s, "I am continuing work from an earlier %s session in this folder. "+
		"You do not have that conversation; this is a summary of it that Caprock put together "+
		"and I have read. Check it against the repository before acting on it.\n", AgentName(b.Agent))

	if passage != nil {
		fmt.Fprintf(&s, "\nThe last thing the previous session said (%s ago):\n\n", HumanAge(age))
		s.WriteString(quote(Clip(strings.TrimSpace(passage.Text), PassageMaxRunes)))
		s.WriteString("\n")
	}

	if g := b.Git; g != nil && !g.NotRepo {
		br := g.Branch
		if br == "" {
			br = branch
		}
		s.WriteString("\nThe working tree now")
		if br != "" {
			fmt.Fprintf(&s, " (branch %s", br)
			if g.Base != "" {
				fmt.Fprintf(&s, ", changes %s", g.Base)
			}
			s.WriteString(")")
		}
		s.WriteString(":\n")
		if len(g.Files) == 0 {
			s.WriteString("- no changes\n")
		}
		for _, f := range g.Files {
			s.WriteString("- " + f + "\n")
		}
		// git's --stat total is not repeated here: it leaves out untracked
		// files, so under a list that includes them it reads as a contradiction.
		if g.More > 0 {
			fmt.Fprintf(&s, "- and %d more\n", g.More)
		}
	}

	if len(b.PRs) > 0 {
		s.WriteString("\nPull requests it opened:\n")
		for _, p := range b.PRs {
			s.WriteString("- " + p.URL + "\n")
		}
	}

	s.WriteString("\nPick up from here.")
	return s.String()
}

// quote prefixes each line with "> " so the passage reads as quoted, not as
// the user's own words.
func quote(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		if l == "" {
			lines[i] = ">"
		} else {
			lines[i] = "> " + l
		}
	}
	return strings.Join(lines, "\n")
}

// Clip cuts to n runes at a sentence boundary where one is near the end, so a
// passage does not stop mid-word. The SessionStart handoff uses it too.
func Clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)[:n]
	cut := string(r)
	if i := strings.LastIndexAny(cut, ".!?\n"); i > len(cut)*3/4 {
		return strings.TrimSpace(cut[:i+1])
	}
	return strings.TrimSpace(cut) + "…"
}

// HumanAge is the coarse form a person reads: minutes, hours, or days. The
// SessionStart handoff uses it too.
func HumanAge(d time.Duration) string {
	switch {
	case d < time.Hour:
		return fmt.Sprintf("%d minutes", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d hours", int(d.Hours()))
	default:
		return fmt.Sprintf("%d days", int(d.Hours()/24))
	}
}
