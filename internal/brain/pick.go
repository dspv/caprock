package brain

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// Choosing the agent the reads go through (ADR-103).
const (
	// DefaultDailyReads caps the calls in a rolling day whose agent reports
	// no tokens (Cursor): a limit Caprock chose, not a figure about tokens
	// or cost — those are unknown for such a reader, and nothing is
	// estimated. The user can change it (daily_reads, ADR-103).
	DefaultDailyReads = 40
	// failingAfter failed calls in a row make a reader failing: the status
	// says so in a sentence, and Auto passes it over for another that works.
	failingAfter = 3
	// failingFor is how long a failing reader stays failing after its last
	// failure; then Auto tries it again.
	failingFor = 6 * time.Hour
	// usedWindow is how far back Auto counts the sessions of each agent.
	usedWindow = 30 * 24 * time.Hour
)

// ReaderOption is one reader as the settings list it.
type ReaderOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Installed is whether its CLI is on this computer; only an installed
	// one can be chosen.
	Installed bool `json:"installed"`
	// Sessions30d is its sessions active in the last 30 days, which Auto
	// ranks by.
	Sessions30d int `json:"sessions_30d"`
	// Model is the model the reads ask it for; "" is its CLI's default.
	Model string `json:"model"`
	// ReportsTokens and ReportsCost are what its answer carries.
	ReportsTokens bool `json:"reports_tokens"`
	ReportsCost   bool `json:"reports_cost"`
	// Failing is set while its last calls all failed.
	Failing bool `json:"failing,omitempty"`
}

// Pick is the reader the next read goes through and why not, when none.
type Pick struct {
	// Reader is the agent's id; "" when none can read.
	Reader string
	Runner Runner
	// Setting is "auto" or the chosen agent.
	Setting string
	// Failing is set when the reader's last calls all failed; LastError is
	// the newest of those failures.
	Failing   bool
	LastError string
	// Problem says, in one sentence, what is needed for reads to work; ""
	// while they do.
	Problem string
	Options []ReaderOption
}

func (e *Engine) readerSetting() string {
	s := strings.TrimSpace(e.Config().Reader)
	if s == "" || !IsReader(s) {
		return ReaderAuto
	}
	return s
}

// installed reports whether a reader's CLI is on this computer.
func (e *Engine) installed(id string) bool {
	if e.Readers == nil {
		// One runner, Runner, which is claude's.
		if id != ReaderClaude {
			return false
		}
		return e.ClaudeFound == nil || e.ClaudeFound()
	}
	if e.Readers[id] == nil {
		return false
	}
	if e.Installed != nil {
		return e.Installed(id)
	}
	return true
}

func (e *Engine) runnerFor(id string) Runner {
	if e.Readers == nil {
		if id == ReaderClaude {
			return e.Runner
		}
		return nil
	}
	return e.Readers[id]
}

// modelFor is the model a reader is asked for: claude's Model (Haiku by
// default), any other's from Models, else "" — its CLI's own default.
func (e *Engine) modelFor(id string) string {
	c := e.Config()
	if id == ReaderClaude || id == "" {
		if m := strings.TrimSpace(c.Model); m != "" {
			return m
		}
		return DefaultModel
	}
	return strings.TrimSpace(c.Models[id])
}

// pick chooses the reader. A chosen one is used when installed. Auto takes,
// among the installed, the agent with the most sessions in the last 30
// days — Claude Code first on a tie, then the order of ReaderOrder — and
// passes over one whose last calls all failed while another has not.
func (e *Engine) pick(ctx context.Context) Pick {
	p := Pick{Setting: e.readerSetting()}
	used := map[string]int{}
	if e.Store != nil {
		if u, err := store.AgentSessionsSince(ctx, e.Store.DB(), ReaderOrder, e.now().Add(-usedWindow).UnixMilli()); err == nil {
			used = u
		}
	}
	failing := map[string]string{}
	for _, id := range ReaderOrder {
		o := ReaderOption{ID: id, Label: ReaderLabel(id), Installed: e.installed(id), Sessions30d: used[id],
			Model: e.modelFor(id), ReportsTokens: ReportsTokens(id), ReportsCost: ReportsCost(id)}
		if o.Installed && e.Store != nil {
			n, at, msg, err := store.BrainReaderStreak(ctx, e.Store.DB(), id, failingAfter)
			if err == nil && n >= failingAfter && e.now().UnixMilli()-at < failingFor.Milliseconds() {
				o.Failing = true
				failing[id] = msg
			}
		}
		p.Options = append(p.Options, o)
	}
	if p.Setting != ReaderAuto {
		if !e.installed(p.Setting) {
			p.Problem = fmt.Sprintf("%s was not found on this computer, so nothing is read: install it and sign in, or choose another agent under Read with.", ReaderLabel(p.Setting))
			return p
		}
		p.Reader = p.Setting
	} else {
		ranked := []ReaderOption{}
		for _, o := range p.Options {
			if o.Installed {
				ranked = append(ranked, o)
			}
		}
		if len(ranked) == 0 {
			p.Problem = "No coding agent was found on this computer to read with, so nothing is read: install Claude Code, Codex, Cursor or Gemini CLI and sign in to it."
			return p
		}
		// Stable on ReaderOrder: a tie keeps Claude Code first.
		sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].Sessions30d > ranked[j].Sessions30d })
		p.Reader = ranked[0].ID
		for _, o := range ranked {
			if !o.Failing {
				p.Reader = o.ID
				break
			}
		}
	}
	p.Runner = e.runnerFor(p.Reader)
	if msg, ok := failing[p.Reader]; ok {
		p.Failing, p.LastError = true, msg
		p.Problem = failingSentence(p.Reader, p.Setting == ReaderAuto, msg)
	}
	return p
}

// failingSentence says why reads with a failing reader stop, and what fixes it.
func failingSentence(id string, auto bool, msg string) string {
	name := ReaderLabel(id)
	why := "its last reads failed"
	m := strings.ToLower(msg)
	switch {
	case notSignedIn(m):
		why = fmt.Sprintf("%s is not signed in", name)
	case strings.Contains(m, "usage limit") || strings.Contains(m, "rate limit") || strings.Contains(m, "quota"):
		why = fmt.Sprintf("%s is at its usage limit", name)
	case strings.Contains(m, "did not answer within"):
		why = fmt.Sprintf("%s took too long to answer", name)
	}
	other := "choose another agent under Read with"
	if auto {
		other = "install and sign in to another agent"
	}
	return fmt.Sprintf("Reading with %s has stopped working (%s): sign in to %s, or %s.", name, why, name, other)
}

func notSignedIn(m string) bool {
	for _, s := range []string{"not logged in", "/login", "login required", "authentication required", "please run", "not authenticated",
		"unauthorized", "invalid api key", "api key", "oauth", "sign in", "authentication_error", "credentials", "auth method"} {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}
