// Package morning builds the Morning summary (ADR-091): one Telegram message
// a day, from the owner's own bot, saying what came in and what ran while
// they were away — the mail Caprock Mail's triage already marked important,
// the sessions that finished per project, and what is waiting for them.
//
// It is pure: the daemon reads the figures and hands them over, so the text
// and the schedule can be tested without a database, a bot or a clock.
// Every number in the message is a count the daemon read (rule 6); nothing
// here estimates.
package morning

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// DefaultAt is the send time until the owner picks another, local.
const DefaultAt = "08:00"

// Limits on what one message lists; the rest is a "+N more" line.
const (
	MailMax     = 5
	ProjectsMax = 8
	WaitingMax  = 5
	// lineMax bounds a sender, a subject, a project or a title, in runes.
	lineMax = 80
)

// MailItem is one important conversation: who wrote and what about. Never
// a body.
type MailItem struct {
	Sender  string `json:"sender"`
	Subject string `json:"subject"`
}

// Mail is the mail section: Important of Total conversations that got mail
// since the last summary, and the newest important ones. Nil when Mail has
// no account or its AI sorting is off: the section is then left out.
type Mail struct {
	Important int        `json:"important"`
	Total     int        `json:"total"`
	Items     []MailItem `json:"items"`
}

// Project is one project's sessions that ended since the last summary.
type Project struct {
	Name     string `json:"name"`
	Finished int    `json:"finished"`
	// AtLimit ended at a plan's usage limit; Errored exited with an error
	// code. Both are among Finished.
	AtLimit int `json:"at_limit,omitempty"`
	Errored int `json:"errored,omitempty"`
}

// Waiting is one session waiting for the owner.
type Waiting struct {
	Project string `json:"project"`
	Title   string `json:"title"`
	// Reason is narrate's Need.Reason: permission, question, plan, error,
	// asks.
	Reason string `json:"reason"`
}

// Summary is everything one message says.
type Summary struct {
	Now      time.Time
	Mail     *Mail
	Projects []Project
	Waiting  []Waiting
	// Approvals is how many tasks wait in the board's needs-you column.
	Approvals int
}

// Empty reports a summary with nothing in any section.
func (s Summary) Empty() bool {
	return (s.Mail == nil || s.Mail.Total == 0) && len(s.Projects) == 0 && len(s.Waiting) == 0 && s.Approvals == 0
}

// escape is Telegram's HTML parse mode's three.
func escape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// clip puts s on one line of at most lineMax runes.
func clip(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= lineMax {
		return s
	}
	return string([]rune(s)[:lineMax-1]) + "…"
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

// reasonText is what a waiting session waits for, in a few words.
func reasonText(r string) string {
	switch r {
	case "permission":
		return "approval"
	case "question":
		return "a question"
	case "plan":
		return "a plan to approve"
	case "error":
		return "stopped on an error"
	default:
		return "asks you something"
	}
}

// Message is the summary as Telegram gets it, in HTML: the header, then
// each section that has something, in the order Mail, Agents overnight,
// Waiting for you. With nothing in any of them it says so in one line.
func Message(s Summary) string {
	var b strings.Builder
	b.WriteString("<b>Good morning · " + s.Now.Weekday().String() + "</b>")
	if s.Empty() {
		b.WriteString("\n\nNothing new since the last summary.")
		return b.String()
	}
	if m := s.Mail; m != nil && m.Total > 0 {
		b.WriteString("\n\n<b>Mail</b> — " + strconv.Itoa(m.Important) + " important of " + strconv.Itoa(m.Total) + " new")
		shown := m.Items
		if len(shown) > MailMax {
			shown = shown[:MailMax]
		}
		for _, it := range shown {
			sender := clip(it.Sender)
			if sender == "" {
				sender = "(no sender)"
			}
			subject := clip(it.Subject)
			if subject == "" {
				subject = "(no subject)"
			}
			b.WriteString("\n• " + escape(sender) + ": " + escape(subject))
		}
		if more := m.Important - len(shown); more > 0 {
			b.WriteString("\n+" + strconv.Itoa(more) + " more")
		}
	}
	if len(s.Projects) > 0 {
		b.WriteString("\n\n<b>Agents overnight</b>")
		shown := s.Projects
		if len(shown) > ProjectsMax {
			shown = shown[:ProjectsMax]
		}
		for _, p := range shown {
			name := clip(p.Name)
			if name == "" {
				name = "(no project)"
			}
			line := escape(name) + " — " + plural(p.Finished, "session finished", "sessions finished")
			if p.AtLimit > 0 {
				line += ", " + strconv.Itoa(p.AtLimit) + " at a usage limit"
			}
			if p.Errored > 0 {
				line += ", " + strconv.Itoa(p.Errored) + " exited with an error"
			}
			b.WriteString("\n• " + line)
		}
		if more := len(s.Projects) - len(shown); more > 0 {
			b.WriteString("\n+" + plural(more, "more project", "more projects"))
		}
	}
	if len(s.Waiting) > 0 || s.Approvals > 0 {
		b.WriteString("\n\n<b>Waiting for you</b>")
		shown := s.Waiting
		if len(shown) > WaitingMax {
			shown = shown[:WaitingMax]
		}
		for _, w := range shown {
			head := clip(w.Project)
			if t := clip(w.Title); t != "" && t != head {
				if head != "" {
					head += " · "
				}
				head += t
			}
			if head == "" {
				head = "A session"
			}
			b.WriteString("\n• " + escape(head) + " — " + reasonText(w.Reason))
		}
		if more := len(s.Waiting) - len(shown); more > 0 {
			b.WriteString("\n+" + plural(more, "more session", "more sessions"))
		}
		if s.Approvals > 0 {
			b.WriteString("\n• " + plural(s.Approvals, "task waits", "tasks wait") + " for your approval")
		}
	}
	return b.String()
}

// Button is one link under the message.
type Button struct {
	Text string
	URL  string
}

// Buttons are the links under the message, to the phone's page at base
// (m.caprock.dev, or the dashboard's address a phone reaches): Open mail
// when the mail section is there, Answer agents, More. None when base is
// empty — a link to a page no phone can open is worse than none.
func Buttons(s Summary, base string) []Button {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return nil
	}
	var out []Button
	if s.Mail != nil && s.Mail.Total > 0 {
		out = append(out, Button{Text: "Open mail", URL: base + "/#/mail"})
	}
	return append(out,
		Button{Text: "Answer agents", URL: base + "/#/"},
		Button{Text: "More", URL: base + "/#/history"})
}

// ParseAt reads "HH:MM" (24-hour); ok false for anything else.
func ParseAt(at string) (h, m int, ok bool) {
	at = strings.TrimSpace(at)
	if len(at) != 5 || at[2] != ':' {
		return 0, 0, false
	}
	h, err1 := strconv.Atoi(at[:2])
	m, err2 := strconv.Atoi(at[3:])
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, 0, false
	}
	return h, m, true
}

// NormalizeAt is at when it is a time, DefaultAt otherwise.
func NormalizeAt(at string) string {
	if h, m, ok := ParseAt(at); ok {
		return fmt.Sprintf("%02d:%02d", h, m)
	}
	return DefaultAt
}

// Day is the marker the daemon keeps for the day a summary went: the local
// date, "2006-01-02".
func Day(t time.Time) string { return t.Format("2006-01-02") }

// Window is when today's summary may go: from the set time to noon — or,
// for a time set at or after noon, for four hours (to midnight at most). A
// Mac asleep at 08:00 sends on waking that morning; one opened after the
// window sends nothing that day, since a morning summary at four in the
// afternoon is news nobody asked for.
func Window(now time.Time, at string) (from, to time.Time) {
	h, m, _ := ParseAt(NormalizeAt(at))
	y, mo, d := now.Date()
	loc := now.Location()
	from = time.Date(y, mo, d, h, m, 0, 0, loc)
	to = time.Date(y, mo, d, 12, 0, 0, 0, loc)
	if h >= 12 {
		to = from.Add(4 * time.Hour)
		if end := time.Date(y, mo, d+1, 0, 0, 0, 0, loc); to.After(end) {
			to = end
		}
	}
	return from, to
}

// Due reports whether the summary should go now: switched on, not sent
// today (lastDay is the marker of the last day one went), and now inside
// today's window. now is local time.
func Due(on bool, now time.Time, at, lastDay string) bool {
	if !on || lastDay == Day(now) {
		return false
	}
	from, to := Window(now, at)
	return !now.Before(from) && now.Before(to)
}

// Since is where "since the last summary" starts: the last one's time, but
// never more than a day back, so a summary turned on after a month off is
// not a month long.
func Since(now time.Time, lastSentMs int64) time.Time {
	floor := now.Add(-24 * time.Hour)
	if lastSentMs <= 0 {
		return floor
	}
	if t := time.UnixMilli(lastSentMs); t.After(floor) && !t.After(now) {
		return t
	}
	return floor
}
