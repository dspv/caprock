package narrate

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/dspv/caprock/internal/event"
)

// HealthDone is a session whose turn ended with nothing asked of anyone: the
// last message Claude wrote reads as a report, not a question. It replaces
// waiting-on-you for those turns, so "Needs you", its counts, the badge and
// the OS notification are left to the turns that do want an answer
// (.ai/04-ui.md § Needs you and Done). Always a guess.
const HealthDone = "done"

// Why a session needs its owner (Need.Reason), first match wins:
//
//   - NeedPermission: a permission dialog is open. Certain.
//   - NeedQuestion: AskUserQuestion's dialog is open. Certain.
//   - NeedPlan: ExitPlanMode's dialog, a plan to approve. Certain.
//   - NeedError: the turn ended on a StopFailure (a limit, an overload).
//     Certain.
//   - NeedAsks: a normal Stop whose last message asks something. A guess.
//   - NeedDone: a normal Stop whose last message asks nothing. A guess; the
//     session's Health is HealthDone, not waiting-on-you.
const (
	NeedPermission = "permission"
	NeedQuestion   = "question"
	NeedPlan       = "plan"
	NeedError      = "error"
	NeedAsks       = "asks"
	NeedDone       = "done"
)

// Need is why a session waits, set beside Health waiting-on-you or done.
type Need struct {
	Reason string `json:"reason"`
	// Detail qualifies the reason: for NeedError why the turn stopped ("rate
	// limit"); for NeedAsks "choice" when the message offers options or an
	// either/or, else "question".
	Detail string `json:"detail,omitempty"`
	// Text is the line of the last message the reading rests on: the
	// question for NeedAsks, the last line for NeedDone. Clipped.
	Text string `json:"text,omitempty"`
	// Guess says Caprock read it from the message's words: no dialog is
	// open, and Claude Code is only waiting for the next message.
	Guess bool `json:"guess,omitempty"`
	// Moved says the owner moved this turn by hand ("needs me?" or "not
	// needed"); it holds until the session's next turn.
	Moved bool `json:"moved,omitempty"`
}

// Move is the owner's correction of a guess, for one turn: the Stop it was
// made at, and which way. Kept in memory by the API (§ Needs you and Done).
type Move struct {
	// StopAt is the Ts of the Stop the owner looked at. A later Stop is a
	// new turn, and the move no longer applies.
	StopAt time.Time
	// Needs is true for "needs me?", false for "not needed".
	Needs bool
}

// needTextMax bounds Need.Text: a line on a card, not the message.
const needTextMax = 200

// tailLines is how many non-empty lines at the end of a message are read for
// a question: a question asked above a closing "Thanks!" still counts.
const tailLines = 3

var (
	// An option line: "1. ...", "2) ...", "a) ...", "(b) ...", "A. ...",
	// "Option A: ...", with list bullets in front allowed.
	optionLine = regexp.MustCompile(`^\s*(?:[-*]\s+)?(?:\*\*)?(?:\(?[a-dA-D]\)|[a-dA-D][.)]\s|\d{1,2}[.)]\s|option\s+[a-d1-9]\b)`)
	// A line that introduces options: "Options:", "Which do you prefer:".
	optionsCue = regexp.MustCompile(`(?i)\b(options?|choose|choice|pick|prefer|either|alternatives?|which|approach(es)?)\b`)
	// Phrases that ask the reader for something, read in the tail.
	asksPhrase = regexp.MustCompile(`(?i)(\bshould i\b|\bshall i\b|\bdo you want\b|\bwould you like\b|\bwant me to\b|\blet me know\b|\btell me\b|\byour call\b|\bup to you\b|\bover to you\b|\byour decision\b|\bneed your\b|\bwaiting for your\b|(?:^|[.!:]\s+)which\b)`)
	// Markup a line may end with after its "?": bold, italics, a quote, a
	// closing bracket.
	trailingMarkup = strings.NewReplacer("**", "", "__", "", "`", "")
)

// AsksSomething reads the last message of a turn the way the Stop rule does
// (.ai/04-ui.md § Needs you and Done): it asks something when one of its
// last lines ends with "?", when it ends on a list of options, or when its
// last lines say "should I", "do you want", "which", "let me know" and the
// like. ok is false when it asks nothing. detail is "choice" or "question";
// line is the line the answer rests on (the question, else the last line).
func AsksSomething(msg string) (ok bool, detail, line string) {
	lines := nonEmptyLines(stripCode(msg))
	if len(lines) == 0 {
		return false, "", ""
	}
	last := lines[len(lines)-1]
	tail := lines
	if len(tail) > tailLines {
		tail = tail[len(tail)-tailLines:]
	}
	choice := func(s string) string {
		if strings.Contains(strings.ToLower(s), " or ") || optionsCue.MatchString(s) && strings.Contains(strings.ToLower(s), "which") {
			return "choice"
		}
		return "question"
	}
	for i := len(tail) - 1; i >= 0; i-- {
		if endsWithQuestion(tail[i]) {
			return true, choice(tail[i]), tail[i]
		}
	}
	// A question inside the last line, followed by what it is about: "You
	// have not tried Gmail yet? It needs an app password."
	if q, ok := questionInside(last); ok {
		return true, choice(q), last
	}
	if q, ok := optionsAtEnd(lines); ok {
		return true, "choice", q
	}
	for i := len(tail) - 1; i >= 0; i-- {
		if asksPhrase.MatchString(tail[i]) {
			return true, choice(tail[i]), tail[i]
		}
	}
	return false, "", last
}

// optionsAtEnd reports whether a message ends on a list of two or more
// options introduced by a line that offers a choice ("Options:", "Which do
// you prefer:"), or lettered "a) / b)" items, which a report rarely uses.
// A numbered list alone is a summary of what was done, not a question.
func optionsAtEnd(lines []string) (string, bool) {
	n := 0
	lettered := 0
	i := len(lines) - 1
	for ; i >= 0 && optionLine.MatchString(lines[i]); i-- {
		n++
		if l := strings.TrimLeft(lines[i], " -*("); len(l) > 1 && strings.ContainsAny(l[:1], "abcdABCD") && (l[1] == ')' || l[1] == '.') {
			lettered++
		}
	}
	if n < 2 {
		return "", false
	}
	if i >= 0 && optionsCue.MatchString(lines[i]) && strings.HasSuffix(strings.TrimSpace(trailingMarkup.Replace(lines[i])), ":") {
		return lines[i], true
	}
	if lettered >= 2 {
		if i >= 0 {
			return lines[i], true
		}
		return lines[len(lines)-n], true
	}
	return "", false
}

// questionInside finds a sentence ending in "?" within a line, one followed
// by more text: "? " then a capital letter or a digit.
func questionInside(s string) (string, bool) {
	s = trailingMarkup.Replace(s)
	for i := 0; i < len(s); i++ {
		if s[i] != '?' || i+2 >= len(s) || s[i+1] != ' ' {
			continue
		}
		r := []rune(s[i+2:])
		if len(r) > 0 && (unicode.IsUpper(r[0]) || unicode.IsDigit(r[0])) {
			start := strings.LastIndexAny(s[:i], ".!:") + 1
			return strings.TrimSpace(s[start : i+1]), true
		}
	}
	return "", false
}

func endsWithQuestion(s string) bool {
	s = strings.TrimSpace(trailingMarkup.Replace(s))
	s = strings.TrimRight(s, " *_)]\"'”’»")
	return strings.HasSuffix(s, "?")
}

// stripCode drops fenced code blocks: a "?" inside a regexp or a URL query
// is not a question to the reader.
func stripCode(s string) string {
	if !strings.Contains(s, "```") {
		return s
	}
	var b strings.Builder
	in := false
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			in = !in
			continue
		}
		if !in {
			b.WriteString(line)
			b.WriteByte('\n')
		}
	}
	return b.String()
}

func nonEmptyLines(s string) []string {
	var out []string
	for _, line := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(line); t != "" && t != "---" {
			out = append(out, t)
		}
	}
	return out
}

// LastMessage is the Stop hook's last_assistant_message, "" when the payload
// has none (an older Claude Code).
func LastMessage(payload json.RawMessage) string {
	var p struct {
		LastAssistantMessage string `json:"last_assistant_message"`
	}
	_ = json.Unmarshal(payload, &p)
	return p.LastAssistantMessage
}

// StopFailure is why a turn failed, from a StopFailure (throttle) payload:
// "rate limit", "overloaded". "" when it does not say.
func StopFailure(payload json.RawMessage) string {
	var p struct {
		Error      string `json:"error"`
		StopReason string `json:"stop_reason"`
	}
	_ = json.Unmarshal(payload, &p)
	why := strings.TrimSpace(p.Error)
	if why == "" {
		why = strings.TrimSpace(p.StopReason)
	}
	return clipRunes(strings.ReplaceAll(why, "_", " "), 40)
}

// StopNeed reads a main-thread Stop: NeedAsks when its last message asks
// something, NeedDone otherwise (an empty or missing message included), both
// guesses. A Stop that follows a StopFailure in the same turn is NeedError:
// Claude Code may fire both, and the failure is the news.
func StopNeed(events []event.Event, stop event.Event) Need {
	if failed, ok := failureBefore(events, stop); ok {
		return Need{Reason: NeedError, Detail: StopFailure(failed.Payload)}
	}
	asks, detail, line := AsksSomething(LastMessage(stop.Payload))
	if asks {
		return Need{Reason: NeedAsks, Detail: detail, Text: clipRunes(line, needTextMax), Guess: true}
	}
	return Need{Reason: NeedDone, Text: clipRunes(line, needTextMax), Guess: true}
}

// failureBefore finds a StopFailure (throttle) in the turn a Stop ends: after
// the turn's prompt and the previous Stop, with no tool call after it.
func failureBefore(events []event.Event, stop event.Event) (event.Event, bool) {
	for i := len(events) - 1; i >= 0; i-- {
		e := events[i]
		if e.Subagent() || e.Ts.After(stop.Ts) || (e.Kind == stop.Kind && e.Ts.Equal(stop.Ts)) {
			continue
		}
		switch e.Kind {
		case event.KindThrottle:
			return e, true
		case event.KindTurnUser, event.KindAgentStop, event.KindToolPre, event.KindToolPost, event.KindPermissionPrompt:
			return event.Event{}, false
		}
	}
	return event.Event{}, false
}

// stoppedPhrase is how a failed turn reads: "stopped: rate limit".
func stoppedPhrase(why string) string {
	if why == "" {
		return "stopped on an error"
	}
	return "stopped: " + why
}

// PromptNeed is the reason a permission dialog gives: a question, a plan, or
// an approval.
func PromptNeed(tool string) string {
	switch tool {
	case "AskUserQuestion":
		return NeedQuestion
	case "ExitPlanMode":
		return NeedPlan
	}
	return NeedPermission
}

// applyMove lets the owner's correction stand over a guess for the turn it
// was made at.
func applyMove(act *Activity, stop event.Event, m *Move) {
	if m == nil || act.Need == nil || !act.Need.Guess || stop.Ts.UnixMilli() != m.StopAt.UnixMilli() {
		return
	}
	switch {
	case m.Needs && act.Health == HealthDone:
		act.Health, act.Phrase = HealthWaiting, "waiting for you"
		act.Need = &Need{Reason: NeedAsks, Text: act.Need.Text, Moved: true}
	case !m.Needs && act.Health == HealthWaiting:
		act.Health, act.Phrase = HealthDone, "done"
		act.Need = &Need{Reason: NeedDone, Text: act.Need.Text, Moved: true}
	}
}
