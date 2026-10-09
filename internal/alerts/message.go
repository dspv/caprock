package alerts

import (
	"encoding/json"
	"fmt"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/toolcmd"
)

// Details is what the daemon knows about the session an alert is about. Any
// field may be empty; the message leaves out what it does not know.
type Details struct {
	// Title is the session's name as Now shows it: the agent's own title, or
	// the first prompt that says something.
	Title string
	// Cwd is the session's directory; Home is the owner's home directory, so
	// the folder reads ~/dev/caprock rather than one of several "caprock"s.
	Cwd, Home string
	Branch    string
	// Agent is the agent's display name. Claude Code, the usual one, is not
	// repeated on every message.
	Agent string
	// Project is the session's project as the dashboard names it; the app's
	// notification leads with it.
	Project string
	// Link is the session's page at an address the phone can open; empty
	// when phone access is off, and then the line is left out rather than
	// offering a loopback address that opens nothing.
	Link string

	// The run a finished alert reports: since the owner's last prompt.
	Run     time.Duration
	CostUSD float64
	Tools   int
	// Files are the paths the run changed, first changed first.
	Files []string
	// Reply is the agent's final reply; empty when the owner switched the
	// line off or there is none.
	Reply string
}

// Limits that keep one alert readable on a lock screen.
const (
	titleMaxRunes   = 80
	folderMaxRunes  = 60
	subjectMaxRunes = 100
	replyMaxRunes   = 120
	filesNamed      = 3
)

// ParseMode is the Telegram parse mode Message and CheckMessage are written
// for. Everything that comes from a session is escaped by html.
const ParseMode = "HTML"

// Message renders an alert as one Telegram message in HTML.
//
// The first line is what a lock screen shows, so it carries what happened and
// which session: "✅ Finished · <title>". Then the folder and branch, and for a
// finished run what it took and changed and the first line of its reply; for a
// dialog, the tool and the command or file it asks about. What this sends to
// Telegram is set out in ADR-036.
func Message(a Alert, d Details) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s · %s", headline(a), html(name(d)))
	if where := location(d); where != "" {
		b.WriteString("\n" + where)
	}
	if a.Kind == KindFinished {
		writeRun(&b, d)
	} else if s := subject(a.Trigger, d); s != "" {
		b.WriteString("\n" + s)
	}
	if d.Link != "" {
		b.WriteString("\n" + html(d.Link))
	}
	if a.LastThisHour {
		fmt.Fprintf(&b, "\n\nThat is %d alerts this hour; the rest wait until it is over.", HourlyCap)
	}
	return b.String()
}

func headline(a Alert) string {
	switch {
	case a.Kind == KindFinished && a.Trigger.Kind == event.KindThrottle:
		if why := failure(a.Trigger.Payload); why != "" {
			return "⚠️ <b>Stopped: " + html(why) + "</b>"
		}
		return "⚠️ <b>Stopped on an error</b>"
	case a.Kind == KindFinished:
		return "✅ <b>Finished</b>"
	case a.Question:
		return "❓ <b>Needs your answer</b>"
	}
	return "⏳ <b>Needs approval</b>"
}

// name is the session's title, or its folder's name when it has none.
func name(d Details) string {
	if t := clip(d.Title, titleMaxRunes); t != "" {
		return t
	}
	if base := path.Base(slashes(d.Cwd)); d.Cwd != "" && base != "/" && base != "." {
		return base
	}
	return "a session"
}

// location is "~/dev/caprock · main", plus the agent when it is not Claude Code.
func location(d Details) string {
	var parts []string
	if p := clipStart(shortPath(d.Cwd, d.Home), folderMaxRunes); p != "" {
		parts = append(parts, "<code>"+html(p)+"</code>")
	}
	// HEAD is what a detached checkout reports: no branch to name.
	if d.Branch != "" && d.Branch != "HEAD" {
		parts = append(parts, html(d.Branch))
	}
	if d.Agent != "" && d.Agent != "Claude Code" {
		parts = append(parts, html(d.Agent))
	}
	return strings.Join(parts, " · ")
}

// writeRun adds what the run took, what it changed and how its reply began.
func writeRun(b *strings.Builder, d Details) {
	for _, line := range runLines(d, html) {
		b.WriteString("\n" + line)
	}
	if r := clip(plainReply(d.Reply), replyMaxRunes); r != "" {
		b.WriteString("\n💬 <i>" + html(r) + "</i>")
	}
}

// runLines is what the run took ("12m · $0.75 · 4 tool calls") and what it
// changed ("2 files changed: a.go, b.go"), each line left out when empty;
// esc escapes the file names for the message they go into.
func runLines(d Details, esc func(string) string) []string {
	var lines, stats []string
	if d.Run > 0 {
		stats = append(stats, duration(d.Run))
	}
	if d.CostUSD > 0 {
		stats = append(stats, money(d.CostUSD))
	}
	if d.Tools > 0 {
		stats = append(stats, plural(d.Tools, "tool call"))
	}
	if len(stats) > 0 {
		lines = append(lines, strings.Join(stats, " · "))
	}
	if len(d.Files) > 0 {
		names := make([]string, 0, filesNamed)
		for i, f := range d.Files {
			if i == filesNamed {
				break
			}
			names = append(names, esc(path.Base(slashes(f))))
		}
		line := plural(len(d.Files), "file") + " changed: " + strings.Join(names, ", ")
		if more := len(d.Files) - filesNamed; more > 0 {
			line += fmt.Sprintf(" +%d", more)
		}
		lines = append(lines, line)
	}
	return lines
}

// subject is what a dialog asks about: "Bash: <code>go test ./...</code>", the
// file an edit would change, or the question AskUserQuestion puts.
func subject(ev event.Event, d Details) string {
	label, what, question := subjectParts(ev, d)
	switch {
	case question:
		return html(what)
	case what == "":
		return html(label)
	case label == "":
		return "<code>" + html(what) + "</code>"
	}
	return html(label) + ": <code>" + html(what) + "</code>"
}

// subjectParts reads a dialog's tool and what it is about, clipped: the
// command, the file, the URL or the query; or the question AskUserQuestion
// puts, with question set.
func subjectParts(ev event.Event, d Details) (label, what string, question bool) {
	label, full, path, question := subjectSource(ev, d)
	if path {
		return label, clipStart(full, subjectMaxRunes), false
	}
	return label, clip(full, subjectMaxRunes), question
}

// subjectSource is subjectParts before clipping; path says full is a file,
// whose end is the part to keep.
func subjectSource(ev event.Event, d Details) (label, full string, path, question bool) {
	var p struct {
		ToolName  string `json:"tool_name"`
		ToolInput struct {
			Command      string `json:"command"`
			FilePath     string `json:"file_path"`
			NotebookPath string `json:"notebook_path"`
			Path         string `json:"path"`
			URL          string `json:"url"`
			Query        string `json:"query"`
			Pattern      string `json:"pattern"`
			Questions    []struct {
				Question string `json:"question"`
			} `json:"questions"`
		} `json:"tool_input"`
	}
	_ = json.Unmarshal(ev.Payload, &p)
	tool := ev.Tool
	if tool == "" {
		tool = p.ToolName
	}
	in := p.ToolInput
	if len(in.Questions) > 0 {
		return "", in.Questions[0].Question, false, true
	}
	switch {
	case in.Command != "":
		// Codex's exec carries a script; the subject is what it ran.
		full = toolcmd.Command(tool, in.Command)
	case in.FilePath != "" || in.NotebookPath != "" || in.Path != "":
		return toolLabel(tool), relPath(firstOf(in.FilePath, in.NotebookPath, in.Path), d.Cwd, d.Home), true, false
	case in.URL != "":
		full = in.URL
	default:
		full = firstOf(in.Query, in.Pattern)
	}
	return toolLabel(tool), full, false, false
}

// toolLabel names an MCP tool the way a person would: "create_issue via github".
func toolLabel(tool string) string {
	if rest, ok := strings.CutPrefix(tool, "mcp__"); ok {
		if server, fn, ok := strings.Cut(rest, "__"); ok {
			return fn + " via " + server
		}
		return rest
	}
	return tool
}

// failure is why a turn failed, from the StopFailure payload: "rate limit".
func failure(payload json.RawMessage) string {
	var p struct {
		Error      string `json:"error"`
		StopReason string `json:"stop_reason"`
	}
	_ = json.Unmarshal(payload, &p)
	return clip(strings.ReplaceAll(firstOf(p.Error, p.StopReason), "_", " "), 40)
}

// plainReply drops the Markdown a reply's first line usually opens with, so a
// heading or a bold lead-in reads as words on a lock screen.
func plainReply(s string) string {
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimLeft(strings.TrimSpace(line), "#> ")
		line = strings.ReplaceAll(line, "**", "")
		if strings.TrimSpace(line) != "" {
			return line
		}
	}
	return ""
}

// shortPath writes the home directory as ~.
func shortPath(p, home string) string {
	p, home = slashes(p), strings.TrimRight(slashes(home), "/")
	if p == "" {
		return ""
	}
	if home != "" && (p == home || strings.HasPrefix(p, home+"/")) {
		return "~" + strings.TrimPrefix(p, home)
	}
	return p
}

// relPath is a file inside the session's directory relative to it, and any
// other file with the home directory as ~.
func relPath(p, cwd, home string) string {
	p, cwd = slashes(p), strings.TrimRight(slashes(cwd), "/")
	if cwd != "" && strings.HasPrefix(p, cwd+"/") {
		return strings.TrimPrefix(p, cwd+"/")
	}
	return shortPath(p, home)
}

// slashes reads a Windows path with forward slashes, so one set of rules
// serves both.
func slashes(p string) string {
	return strings.ReplaceAll(strings.TrimSpace(p), `\`, "/")
}

// clip is the first non-empty line, whitespace collapsed, cut on a rune
// boundary with an ellipsis.
func clip(s string, limit int) string {
	for _, line := range strings.Split(s, "\n") {
		line = strings.Join(strings.Fields(line), " ")
		if line == "" {
			continue
		}
		if utf8.RuneCountInString(line) <= limit {
			return line
		}
		return strings.TrimSpace(string([]rune(line)[:limit-1])) + "…"
	}
	return ""
}

// clipStart keeps a path's end, where its name is: "…/preview/proj/a.go".
func clipStart(s string, limit int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= limit {
		return string(r)
	}
	return "…" + string(r[len(r)-limit+1:])
}

// html escapes text for Telegram's HTML parse mode, which needs exactly these
// three; every string that came from a session goes through it.
func html(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

func firstOf(ss ...string) string {
	for _, s := range ss {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func duration(d time.Duration) string {
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	return fmt.Sprintf("%dh %02dm", int(d.Hours()), int(d.Minutes())%60)
}

func money(v float64) string {
	if v >= 100 {
		return fmt.Sprintf("$%.0f", v)
	}
	return fmt.Sprintf("$%.2f", v)
}

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

// CheckMessage is what "Send a test alert" sends: the same shape as a real one,
// saying it is a test, so the person setting it up sees what will arrive.
func CheckMessage(link string) string {
	var b strings.Builder
	b.WriteString("🔔 <b>Test alert</b> · Caprock\nAlerts reach this chat. A real one opens with what happened and the session's name, then its folder and branch: for a finished run, how long it took, its cost, tool calls, changed files and the first line of the reply; for a dialog, the command or file it asks about.")
	if link != "" {
		b.WriteString("\n" + html(link))
	}
	return b.String()
}
