package alerts

import (
	"encoding/json"
	"fmt"
	"path"
	"strings"

	"github.com/dspv/caprock/internal/event"
)

// Notification is an alert as the app shows it: the `notify` frame on
// /v1/live (.ai/03-contracts.md § Notify frame). The decision is the one
// Telegram reads; only the rendering differs — plain text, and it never leaves
// the machine.
type Notification struct {
	// ID names this alert and nothing else, so a frame replayed after a
	// reconnect is recognised as one already shown.
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	SessionID string `json:"session_id"`
	Project   string `json:"project,omitempty"`
	// Title is what a lock screen shows first: what happened and where,
	// "Needs approval · caprock".
	Title string `json:"title"`
	// Body is the session, then what it asks about or what the run did.
	Body string `json:"body"`
	// PromptID is the permission prompt the session waits on (ADR-035) when
	// Caprock can answer it; Actions are the answers offered for it.
	PromptID string   `json:"prompt_id,omitempty"`
	Actions  []string `json:"actions,omitempty"`
}

// The kinds a notification has beyond the alert's own: a turn that ended on an
// error rather than a Stop.
const kindError = "error"

// Notify renders an alert for the app. promptID is the owned session's waiting
// prompt, empty when there is none Caprock can answer; with one, the
// notification offers Deny, and Approve too when it shows the whole request.
func Notify(a Alert, d Details, promptID string) Notification {
	kind := string(a.Kind)
	if a.Kind == KindFinished && a.Trigger.Kind == event.KindThrottle {
		kind = kindError
	}
	n := Notification{
		ID:        fmt.Sprintf("%s-%s-%d", a.Kind, a.SessionID, a.Trigger.Ts.UnixMilli()),
		Kind:      kind,
		SessionID: a.SessionID,
		Project:   project(d),
		Title:     plainHeadline(a) + " · " + project(d),
		Body:      strings.Join(bodyLines(a, d), "\n"),
	}
	if promptID != "" && a.Kind == KindApproval && !a.Question {
		n.PromptID, n.Actions = promptID, []string{"deny"}
		if shownWhole(a.Trigger, d) {
			n.Actions = []string{"allow", "deny"}
		}
	}
	return n
}

// shownWhole reports whether the body shows all of what the dialog asks about:
// its command, file, URL or query, on one line and not clipped. Approve from a
// notification is offered only then, because a button must not answer a
// question it did not show (ADR-035); otherwise the prompt card has it.
func shownWhole(ev event.Event, d Details) bool {
	_, what, _ := subjectParts(ev, d)
	_, full, _, _ := subjectSource(ev, d)
	return what != "" && what == strings.TrimSpace(full)
}

// project is what the title names: the project, else the folder, else the
// session.
func project(d Details) string {
	if p := clip(d.Project, folderMaxRunes); p != "" {
		return p
	}
	if base := path.Base(slashes(d.Cwd)); d.Cwd != "" && base != "/" && base != "." {
		return clip(base, folderMaxRunes)
	}
	return name(d)
}

func plainHeadline(a Alert) string {
	switch {
	case a.Kind == KindFinished && a.Trigger.Kind == event.KindThrottle:
		if why := failure(a.Trigger.Payload); why != "" {
			return "Stopped: " + why
		}
		return "Stopped on an error"
	case a.Kind == KindFinished:
		return "Finished"
	case a.Question:
		return "Needs your answer"
	}
	return "Needs approval"
}

// bodyLines: the session's name with its branch and a non-Claude agent; then,
// for a dialog, the tool and its command or file, or the question; for a
// finished run, its time, cost and changes and how the reply began.
func bodyLines(a Alert, d Details) []string {
	who := []string{name(d)}
	if d.Branch != "" && d.Branch != "HEAD" {
		who = append(who, d.Branch)
	}
	if d.Agent != "" && d.Agent != "Claude Code" {
		who = append(who, d.Agent)
	}
	var lines []string
	// A session with no title is named after its folder, which the title
	// already says; alone, that line would only repeat it.
	if len(who) > 1 || who[0] != project(d) {
		lines = append(lines, strings.Join(who, " · "))
	}
	if a.Kind == KindFinished {
		lines = append(lines, runLines(d, func(s string) string { return s })...)
		if r := clip(plainReply(d.Reply), replyMaxRunes); r != "" {
			lines = append(lines, "“"+r+"”")
		}
	} else if s := plainSubject(a.Trigger, d); s != "" {
		if by := subagentOf(a.Trigger); by != "" {
			// Claude Code draws a subagent's dialog in the parent's terminal;
			// unnamed, it read as the parent's own request.
			s = by + " · " + s
		}
		lines = append(lines, s)
	}
	if a.LastThisHour {
		lines = append(lines, fmt.Sprintf("That is %d this hour; the rest wait until it is over.", HourlyCap))
	}
	return lines
}

// plainSubject is subject without markup: "Bash: go test ./...".
func plainSubject(ev event.Event, d Details) string {
	label, what, _ := subjectParts(ev, d)
	switch {
	case what == "":
		return label
	case label == "":
		return what
	}
	return label + ": " + what
}

// subagentOf names the subagent that asked, "Subagent (general-purpose)", or
// "" when the main thread did.
func subagentOf(ev event.Event) string {
	if ev.AgentID == "" {
		return ""
	}
	var p struct {
		AgentType string `json:"agent_type"`
	}
	_ = json.Unmarshal(ev.Payload, &p)
	if t := clip(strings.TrimSpace(p.AgentType), 40); t != "" {
		return "Subagent (" + t + ")"
	}
	return "Subagent"
}
