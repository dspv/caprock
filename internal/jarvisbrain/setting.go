// Package jarvisbrain is Jarvis V2's chat and brain (ADR-097): the thread
// the person writes to Jarvis in, the deterministic routing a message gets
// when no model is asked, the brain — the person's own Claude Code or Codex,
// run headless on the sign-in they chose, with no tool — that turns plain
// speech into actions, the auto-answer of routine question dialogs, and the
// "Done:" note when an agent Jarvis gave work to finishes its turn.
//
// Nothing here talks to a server of Caprock's. A brain run is the user's own
// CLI, on the user's own login, and what it is given is exactly what
// prompt.go builds (documented in docs/jarvis-brain.md).
package jarvisbrain

import (
	"errors"
	"strings"
)

// Brain agents.
const (
	AgentClaude = "claude"
	AgentCodex  = "codex"
	AgentOff    = "off"
)

// Auto-answer choices.
const (
	AutoRoutine = "routine"
	AutoOff     = "off"
)

// Brain states, as the digest's `brain.state` names them.
const (
	StateOff       = "off"
	StateReady     = "ready"
	StateSignedOut = "signed-out"
	StateError     = "error"
	StateUnchosen  = "unchosen"
)

// Setting is the `jarvis_brain` setting: which agent the brain runs on, on
// which sign-in ("" is the sign-in new sessions of that agent start on,
// "default" the user's own), and whether it answers routine questions.
type Setting struct {
	Agent      string `json:"agent"`
	Sub        string `json:"sub,omitempty"`
	AutoAnswer string `json:"auto_answer"`
}

// Normalize checks a setting from PUT /v1/settings: agent is claude, codex
// or off; auto_answer routine (the default) or off; sub a sign-in id, never
// an API-key provider.
func (s Setting) Normalize() (Setting, error) {
	s.Agent = strings.TrimSpace(s.Agent)
	s.Sub = strings.TrimSpace(s.Sub)
	switch s.Agent {
	case AgentClaude, AgentCodex, AgentOff:
	default:
		return s, errors.New(`jarvis_brain.agent is "claude", "codex" or "off"`)
	}
	switch s.AutoAnswer {
	case "":
		s.AutoAnswer = AutoRoutine
	case AutoRoutine, AutoOff:
	default:
		return s, errors.New(`jarvis_brain.auto_answer is "routine" or "off"`)
	}
	if s.Agent == AgentOff {
		s.Sub = ""
	}
	if len(s.Sub) > 32 {
		return s, errors.New("jarvis_brain.sub is a sign-in id from Settings → Subscriptions")
	}
	for _, r := range s.Sub {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return s, errors.New("jarvis_brain.sub is a sign-in id from Settings → Subscriptions")
		}
	}
	if s.Sub == "deepseek" || s.Sub == "kimi" {
		return s, errors.New("the brain runs on a sign-in, not on an API key: pick a Claude Code or Codex sign-in")
	}
	return s, nil
}

// On reports whether the brain is chosen and not off.
func (s Setting) On() bool { return s.Agent == AgentClaude || s.Agent == AgentCodex }

// Status is the digest's `brain` object.
type Status struct {
	State      string `json:"state"`
	Agent      string `json:"agent,omitempty"`
	Sub        string `json:"sub,omitempty"`
	AutoAnswer string `json:"auto_answer"`
	Note       string `json:"note,omitempty"`
	// SpentTodayUSD is what the brain's runs cost since local midnight, as
	// the agent reported it (Claude Code reports a cost; Codex does not, so
	// its runs count in RunsToday only when they carry one).
	SpentTodayUSD float64 `json:"spent_today_usd"`
	RunsToday     int     `json:"runs_today"`
}
