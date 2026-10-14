// Package narrate turns tool events into the human-readable phrases the Now
// screen shows ("editing main.go", "running go test — 2nd attempt") and derives
// a session's health badge and plan progress. Pure functions, unit-tested; the
// UI and any future TUI render what this package says. See .ai/04-ui.md.
package narrate

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/toolcmd"
)

// Health badges (spec: working / idle / waiting-on-you / looping? / error).
const (
	HealthWorking = "working"
	HealthIdle    = "idle"
	HealthWaiting = "waiting-on-you"
	HealthLooping = "looping"
	HealthError   = "error"
	HealthEnded   = "ended"
)

// Plan is TodoWrite-derived progress.
type Plan struct {
	Done  int    `json:"done"`
	Total int    `json:"total"`
	Next  string `json:"next,omitempty"` // first in_progress or pending item
}

// Activity is the current-activity summary for a session.
type Activity struct {
	Phrase string    `json:"phrase"`
	Tool   string    `json:"tool,omitempty"`
	At     time.Time `json:"at"`
	Health string    `json:"health"`
	Plan   *Plan     `json:"plan,omitempty"`
	// Repeats counts consecutive identical (tool, sample) calls ending at the latest event.
	Repeats int `json:"repeats,omitempty"`
	// Background is how many subagents are still working after the main
	// thread ended its turn. Claude Code resumes the parent by itself when
	// they finish, so nothing is wanted from the user and Health is working.
	// Zero otherwise.
	Background int `json:"background,omitempty"`
	// Provisional marks a status read from input Caprock typed into the
	// session rather than from an event the session wrote: Enter at a
	// waiting prompt reads working for NudgeWindow, and goes back to what
	// the events say when nothing follows it.
	Provisional bool `json:"provisional,omitempty"`
	// FromInput is set when a Nudge decided the status. A caller that would
	// otherwise judge the session by how long its events have been quiet
	// (the session row's idle status) leaves it alone.
	FromInput bool `json:"-"`
}

// Kinds of Nudge.
const (
	// NudgeSubmit is Enter typed, or sent, at a session not showing a
	// permission menu: a message was submitted, or nothing was.
	NudgeSubmit = "submit"
	// NudgeApproved is a permission menu answered with an option that lets
	// the call run (a key in the terminal, or a button anywhere).
	NudgeApproved = "approved"
	// NudgeRejected is a permission menu answered No, or Esc / Ctrl+C at
	// it: Claude Code drops the call and returns to its prompt.
	NudgeRejected = "rejected"
)

// NudgeWindow is how long a NudgeSubmit reads working with no event behind
// it. A prompt Claude Code accepted fires UserPromptSubmit within
// milliseconds; Enter that submitted nothing (an empty prompt, a slash
// command's menu) is not work, and the status goes back.
const NudgeWindow = 5 * time.Second

// Nudge is input to a session Caprock holds, seen as it was typed: what the
// user did that the session has not yet written an event for. Only a session
// Caprock started has one — every key and button reaches it through the
// daemon — and only the newest is kept.
type Nudge struct {
	At   time.Time
	Kind string
}

// toolInput extracts common tool_input fields from a tool.* payload.
type toolInput struct {
	FilePath     string          `json:"file_path"`
	NotebookPath string          `json:"notebook_path"`
	Command      string          `json:"command"`
	Pattern      string          `json:"pattern"`
	Query        string          `json:"query"`
	URL          string          `json:"url"`
	Prompt       string          `json:"prompt"`
	Description  string          `json:"description"`
	SubagentType string          `json:"subagent_type"`
	Skill        string          `json:"skill"`
	Todos        []todo          `json:"todos"`
	Raw          json.RawMessage `json:"-"`
}

type todo struct {
	Content    string `json:"content"`
	Status     string `json:"status"` // pending | in_progress | completed
	ActiveForm string `json:"activeForm"`
}

func parseInput(payload json.RawMessage) toolInput {
	var p struct {
		ToolInput json.RawMessage `json:"tool_input"`
	}
	_ = json.Unmarshal(payload, &p)
	var in toolInput
	_ = json.Unmarshal(p.ToolInput, &in)
	in.Raw = p.ToolInput
	return in
}

// Phrase renders one tool call as a present-participle phrase.
func Phrase(tool string, payload json.RawMessage) string {
	in := parseInput(payload)
	base := baseName
	switch tool {
	case "Read":
		if f := base(in.FilePath); f != "" {
			return "reading " + f
		}
		return "reading a file"
	case "Edit", "MultiEdit":
		if f := base(in.FilePath); f != "" {
			return "editing " + f
		}
		return "editing a file"
	case "Write":
		if f := base(in.FilePath); f != "" {
			return "writing " + f
		}
		return "writing a file"
	case "NotebookEdit":
		if f := base(in.NotebookPath); f != "" {
			return "editing notebook " + f
		}
		return "editing a notebook"
	case "Bash":
		return "running " + commandHead(in.Command)
	case "shell", "local_shell", "exec_command":
		// Codex's shell tools: the command line, as Bash's.
		return "running " + commandHead(toolcmd.Command(tool, in.Command))
	case "exec":
		// Codex's exec runs a script that calls one of its own tools; the
		// phrase is what that call did, not the JavaScript (toolcmd).
		inner, arg, ok := toolcmd.ScriptCall(in.Command)
		switch {
		case !ok:
			return "running " + commandHead(in.Command)
		case inner == "exec_command" && arg != "":
			return "running " + commandHead(arg)
		case inner == "apply_patch" && arg != "":
			return "editing " + base(arg)
		}
		return "using " + inner
	case "Grep":
		if in.Pattern != "" {
			return "searching for " + quote(in.Pattern)
		}
		return "searching"
	case "Glob":
		if in.Pattern != "" {
			return "finding files " + quote(in.Pattern)
		}
		return "finding files"
	case "WebFetch":
		if h := host(in.URL); h != "" {
			return "fetching " + h
		}
		return "fetching a page"
	case "WebSearch":
		if in.Query != "" {
			return "searching the web for " + quote(in.Query)
		}
		return "searching the web"
	case "TodoWrite", "TaskCreate", "TaskUpdate":
		if p := planFrom(in); p != nil && p.Total > 0 {
			return fmt.Sprintf("planning — %d/%d done", p.Done, p.Total)
		}
		return "planning"
	case "Task", "Agent":
		if in.SubagentType != "" {
			return "delegating to a " + in.SubagentType + " subagent"
		}
		return "delegating to a subagent"
	case "Skill":
		if in.Skill != "" {
			return "using skill " + in.Skill
		}
		return "using a skill"
	case "AskUserQuestion":
		return "asking you a question"
	case "":
		return "thinking"
	}
	if strings.HasPrefix(tool, "mcp__") {
		parts := strings.SplitN(strings.TrimPrefix(tool, "mcp__"), "__", 2)
		if len(parts) == 2 {
			return parts[1] + " via " + parts[0]
		}
		return "calling " + parts[0]
	}
	return "using " + tool
}

// baseName is filepath.Base for both separator styles: transcripts from a Windows
// machine may be read on any OS (and vice versa).
func baseName(p string) string {
	p = strings.TrimRight(p, `/\`)
	if p == "" {
		return ""
	}
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		return p[i+1:]
	}
	return p
}

func commandHead(cmd string) string {
	cmd = strings.TrimSpace(cmd)
	if cmd == "" {
		return "a command"
	}
	// First line, first ~6 tokens, cut at pipes/&&.
	if i := strings.IndexAny(cmd, "\n"); i >= 0 {
		cmd = cmd[:i]
	}
	for _, sep := range []string{" && ", " || ", " | ", ";"} {
		if i := strings.Index(cmd, sep); i > 0 {
			cmd = cmd[:i] + " …"
			break
		}
	}
	fields := strings.Fields(cmd)
	if len(fields) > 6 {
		cmd = strings.Join(fields[:6], " ") + " …"
	}
	cmd = clipRunes(cmd, 60)
	return "`" + cmd + "`"
}

func quote(s string) string {
	return "“" + clipRunes(strings.TrimSpace(s), 40) + "”"
}

// clipRunes truncates to at most n runes. These strings are serialized straight
// into the API as a session's activity phrase, and slicing UTF-8 by byte index
// cut through multi-byte characters — encoding/json does not error on that, it
// silently substitutes U+FFFD, so a Russian command line rendered as mojibake
// in the dashboard.
func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i] + "…"
		}
		count++
	}
	return s
}

func host(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	return strings.TrimPrefix(u.Host, "www.")
}

func planFrom(in toolInput) *Plan {
	if len(in.Todos) == 0 {
		return nil
	}
	p := &Plan{Total: len(in.Todos)}
	for _, t := range in.Todos {
		switch t.Status {
		case "completed":
			p.Done++
		case "in_progress":
			if p.Next == "" {
				p.Next = firstNonEmpty(t.ActiveForm, t.Content)
			}
		}
	}
	if p.Next == "" {
		for _, t := range in.Todos {
			if t.Status == "pending" {
				p.Next = t.Content
				break
			}
		}
	}
	return p
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// Ordinal renders 2 → "2nd", 3 → "3rd", 11 → "11th".
func Ordinal(n int) string {
	suffix := "th"
	switch {
	case n%100 >= 11 && n%100 <= 13:
	case n%10 == 1:
		suffix = "st"
	case n%10 == 2:
		suffix = "nd"
	case n%10 == 3:
		suffix = "rd"
	}
	return fmt.Sprintf("%d%s", n, suffix)
}

// futureSkew is how far ahead of the daemon's clock an event may be stamped
// and still count as fresh. The transcript and the daemon share one clock, so
// anything past rounding and a slow write is not a live session.
const futureSkew = 2 * time.Minute

// Options tune Summarize.
type Options struct {
	Now          time.Time
	IdleAfter    time.Duration // no events for this long ⇒ idle (default 5m)
	Looping      bool          // an unexpired loop alert exists for the session
	SessionEnded bool
	// LiveSubagents is how many subagents are working in the session now
	// (store.LiveSubagents). With the main thread's turn ended, they make the
	// session "working in background", not waiting on anyone.
	LiveSubagents int
	// MainLast is the main thread's newest event, for a caller that had to
	// look it up because events holds none (a parent whose subagents logged
	// more than the window). Nil means "find it in events".
	MainLast *event.Event
	// Nudge is the newest input Caprock typed into the session (owned
	// sessions only). It decides the status only when it came after the
	// newest event, so the next event always wins.
	Nudge *Nudge
}

// BackgroundPhrase is what a session whose turn ended says while n of its
// subagents still work.
func BackgroundPhrase(n int) string {
	return fmt.Sprintf("background agents working · %d", n)
}

// MainTurnEnded reports whether the main thread's newest event is a
// top-level Stop: the parent finished its turn, whatever its subagents still
// do. mainLast, when given, is that event; otherwise it is found in events
// (oldest first).
func MainTurnEnded(events []event.Event, mainLast *event.Event) bool {
	if mainLast == nil {
		for i := len(events) - 1; i >= 0; i-- {
			if !events[i].Subagent() {
				mainLast = &events[i]
				break
			}
		}
	}
	return mainLast != nil && mainLast.Kind == event.KindAgentStop && mainLast.AgentID == ""
}

// Summarize derives the activity for a session from its most recent events
// (oldest first). It looks at the last tool.pre for the phrase, the last event
// kind for the health badge, and the last TodoWrite for plan progress.
func Summarize(events []event.Event, opt Options) Activity {
	now := opt.Now
	if now.IsZero() {
		now = time.Now()
	}
	idleAfter := opt.IdleAfter
	if idleAfter <= 0 {
		idleAfter = 5 * time.Minute
	}
	act := Activity{Phrase: "idle", Health: HealthIdle}
	if len(events) == 0 {
		if opt.SessionEnded {
			act.Health, act.Phrase = HealthEnded, "ended"
		}
		return act
	}
	last := events[len(events)-1]
	act.At = last.Ts

	// Plan: last TodoWrite / task list update.
	for i := len(events) - 1; i >= 0; i-- {
		e := events[i]
		if e.Kind == event.KindToolPre && (e.Tool == "TodoWrite") {
			if p := planFrom(parseInput(e.Payload)); p != nil {
				act.Plan = p
			}
			break
		}
	}

	// Phrase: last tool.pre, with repeat counting.
	var lastTool *event.Event
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Kind == event.KindToolPre {
			lastTool = &events[i]
			break
		}
	}
	switch last.Kind {
	case event.KindAgentStop:
		if last.AgentID == "" {
			act.Phrase = "waiting for you"
			act.Health = HealthWaiting
		} else {
			act.Phrase = "subagent finished"
			act.Health = HealthWorking
		}
	case event.KindPermissionPrompt:
		// Claude Code is showing a permission dialog, and nothing moves until
		// somebody answers it. The call it asks about is the prompt's own
		// (its payload carries tool_name and tool_input), else the last one
		// made. A subagent's dialog is drawn in the parent's terminal, so the
		// phrase says whose it is: unnamed, it read as the parent's request.
		act.Phrase = "waiting for approval"
		if last.Tool == "AskUserQuestion" {
			// Its dialog is a question with answers, not Yes and No.
			act.Phrase = "waiting for your answer"
		} else if last.Tool != "" && parseInput(last.Payload).Raw != nil {
			act.Phrase += " — " + Phrase(last.Tool, last.Payload)
			act.Tool = last.Tool
		} else if lastTool != nil {
			act.Phrase += " — " + Phrase(lastTool.Tool, lastTool.Payload)
			act.Tool = lastTool.Tool
		}
		if by := subagentLabel(last); by != "" {
			act.Phrase = by + " " + act.Phrase
		}
		act.Health = HealthWaiting
	case event.KindTurnUser:
		act.Phrase = "reading your prompt"
		act.Health = HealthWorking
	case event.KindTurnAssistant:
		act.Phrase = "responding"
		act.Health = HealthWorking
	case event.KindToolPre:
		act.Phrase = Phrase(last.Tool, last.Payload)
		act.Tool = last.Tool
		act.Health = HealthWorking
	case event.KindToolPost:
		if lastTool != nil {
			act.Phrase = Phrase(lastTool.Tool, lastTool.Payload)
			act.Tool = lastTool.Tool
		} else {
			act.Phrase = "working"
		}
		act.Health = HealthWorking
		if isError(last.Payload) {
			act.Health = HealthError
			act.Phrase += " — failed"
		}
	case event.KindContextCompact:
		act.Phrase = "compacting context"
		act.Health = HealthWorking
	case event.KindContextClear:
		// Past tense, and not "working": /clear leaves the session sitting at
		// an empty prompt waiting for a human. Narrating it as "compacting
		// context" claimed Claude was busy doing something it had already
		// finished, at the one moment the owner is deciding whether to wait.
		act.Phrase = "context cleared"
		act.Health = HealthIdle
	case event.KindSessionContinue:
		act.Phrase = "waiting at the prompt"
		act.Health = HealthIdle
	case event.KindAgentSpawn:
		act.Phrase = "session started"
		act.Health = HealthWorking
	default:
		act.Phrase = "working"
		act.Health = HealthWorking
	}
	if lastTool != nil && (last.Kind == event.KindToolPre || last.Kind == event.KindToolPost) {
		act.Repeats = repeats(events, lastTool)
		if act.Repeats >= 2 {
			act.Phrase += " — " + Ordinal(act.Repeats) + " attempt"
		}
	}
	// Staleness overrides: no events for a while ⇒ idle (unless waiting on the user).
	// A stamp from the future is not a fresh event either: ingest accepts one
	// up to a day ahead (a clock problem, not a fact), and "now minus a future
	// time" is negative, so a hand-written transcript stamped hours ahead would
	// read "working" for those hours with nothing behind it (2026-10-14).
	if age := now.Sub(last.Ts); act.Health == HealthWorking && (age > idleAfter || age < -futureSkew) {
		act.Health = HealthIdle
		act.Phrase = "was " + act.Phrase
	}
	applyNudge(&act, last, lastTool, opt.Nudge, now, idleAfter)
	// The turn ended but subagents it started in the background still work.
	// Claude Code resumes the parent by itself when they finish, so the
	// session wants nothing from anyone: it read "waiting on you" beside "1
	// subagent working" (owner, 2026-10-09). A permission dialog, the main
	// thread's or a subagent's, still waits — that is the one thing that does.
	if opt.LiveSubagents > 0 && last.Kind != event.KindPermissionPrompt && MainTurnEnded(events, opt.MainLast) {
		switch act.Health {
		case HealthWaiting, HealthWorking, HealthIdle:
			act.Health = HealthWorking
			act.Phrase = BackgroundPhrase(opt.LiveSubagents)
			act.Tool = ""
			act.Repeats = 0
			act.Background = opt.LiveSubagents
		}
	}
	if opt.Looping {
		act.Health = HealthLooping
	}
	if opt.SessionEnded {
		act.Health = HealthEnded
	}
	return act
}

// applyNudge lets input the session has not answered with an event yet
// decide the status (owner, 2026-10-14: "waiting for you" for 10-20 s after
// he had set the agent going). A permission dialog writes nothing when it is
// answered — the call's PostToolUse comes when the call finishes, which for a
// build is minutes — so the answer read where it was typed is the only timely
// signal there is. Each case needs the newest event to be the one the input
// answers; any later event is the session speaking for itself.
func applyNudge(act *Activity, last event.Event, lastTool *event.Event, n *Nudge, now time.Time, idleAfter time.Duration) {
	if n == nil || !n.At.After(last.Ts) {
		return
	}
	switch act.Health {
	case HealthLooping, HealthError, HealthEnded:
		return
	}
	switch n.Kind {
	case NudgeApproved:
		if last.Kind != event.KindPermissionPrompt || last.Tool == "AskUserQuestion" {
			return
		}
		phrase := "approved"
		if last.Tool != "" && parseInput(last.Payload).Raw != nil {
			phrase += " — " + Phrase(last.Tool, last.Payload)
			act.Tool = last.Tool
		} else if lastTool != nil {
			phrase += " — " + Phrase(lastTool.Tool, lastTool.Payload)
			act.Tool = lastTool.Tool
		}
		act.Phrase, act.Health = phrase, HealthWorking
		if now.Sub(n.At) > idleAfter {
			act.Health, act.Phrase = HealthIdle, "was "+phrase
		}
	case NudgeRejected:
		if last.Kind != event.KindPermissionPrompt || last.Tool == "AskUserQuestion" {
			return
		}
		// Claude Code drops the call and returns to its prompt.
		act.Phrase, act.Health, act.Tool = "waiting for you", HealthWaiting, ""
	case NudgeSubmit:
		if now.Sub(n.At) >= NudgeWindow || last.Kind == event.KindPermissionPrompt {
			return
		}
		if act.Health != HealthWaiting && act.Health != HealthIdle {
			return
		}
		act.Phrase, act.Health, act.Tool, act.Provisional = "starting on your message", HealthWorking, "", true
	default:
		return
	}
	act.At, act.Repeats, act.FromInput = n.At, 0, true
}

// subagentLabel is "subagent (general-purpose)" for an event a subagent
// raised, "subagent" when its payload names no type, "" for the main thread.
func subagentLabel(e event.Event) string {
	if e.AgentID == "" {
		return ""
	}
	var p struct {
		AgentType string `json:"agent_type"`
	}
	_ = json.Unmarshal(e.Payload, &p)
	if t := clipRunes(strings.TrimSpace(p.AgentType), 40); t != "" {
		return "subagent (" + t + ")"
	}
	return "subagent"
}

func isError(payload json.RawMessage) bool {
	var p struct {
		IsError      bool            `json:"is_error"`
		ToolResponse json.RawMessage `json:"tool_response"`
	}
	if json.Unmarshal(payload, &p) != nil {
		return false
	}
	if p.IsError {
		return true
	}
	// Hook PostToolUse: tool_response may be an object with is_error / error fields.
	var tr struct {
		IsError bool   `json:"is_error"`
		Error   string `json:"error"`
	}
	if json.Unmarshal(p.ToolResponse, &tr) == nil && (tr.IsError || tr.Error != "") {
		return true
	}
	return false
}

// repeats counts how many of the trailing tool.pre events share the last one's
// (tool, described sample), stopping at the first different call.
func repeats(events []event.Event, last *event.Event) int {
	key := last.Tool + "|" + Phrase(last.Tool, last.Payload)
	n := 0
	for i := len(events) - 1; i >= 0; i-- {
		e := events[i]
		if e.Kind != event.KindToolPre {
			continue
		}
		if e.Tool+"|"+Phrase(e.Tool, e.Payload) != key {
			break
		}
		n++
	}
	return n
}
