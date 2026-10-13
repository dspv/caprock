package api

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"

	"github.com/dspv/caprock/internal/toolcmd"
)

// doingMax is how long the cockpit's "doing now" line may run, in runes.
const doingMax = 60

// Where a subagent's doing phrase came from (SubagentNow.DoingFrom).
const (
	// doingFromCall: its newest call's own description — the phrase Claude
	// wrote for a Bash command or an Agent launch.
	doingFromCall = "call"
	// doingFromTool: made from the call's tool and target ("Editing x.go").
	doingFromTool = "tool"
	// doingFromTask: the task its parent spawned it with; no call said more.
	doingFromTask = "task"
)

// subagentDoing is roughly what a subagent is doing now, on one short line,
// read from what the row already holds: its newest call (tool and input)
// and the task it was given. Claude Code's own activity line ("Rerunning
// AppShell and DiffFiles tests") is not written anywhere Caprock can read,
// so this is the nearest honest thing: first the call's own description,
// then a phrase from a small table of tools and their target, then the task.
// Nothing is guessed past that: an unknown tool falls through to the task.
func subagentDoing(tool string, input json.RawMessage, task string) (string, string) {
	var in map[string]any
	_ = json.Unmarshal(input, &in)
	str := func(k string) string { s, _ := in[k].(string); return strings.TrimSpace(s) }
	if d := str("description"); d != "" && tool != "" {
		return oneLine(d, doingMax), doingFromCall
	}
	if p := toolPhrase(tool, str); p != "" {
		return oneLine(p, doingMax), doingFromTool
	}
	if task != "" {
		return oneLine(task, doingMax), doingFromTask
	}
	return "", ""
}

// toolPhrase is the phrase the table gives a call, "" for a tool it does not
// know or a call missing its target.
func toolPhrase(tool string, str func(string) string) string {
	file := func() string {
		for _, k := range []string{"file_path", "notebook_path", "filePath", "path"} {
			if f := str(k); f != "" {
				return baseOf(f)
			}
		}
		return ""
	}
	with := func(verb, target string) string {
		if target == "" {
			return ""
		}
		return verb + " " + target
	}
	switch tool {
	case "Read", "NotebookRead":
		return with("Reading", file())
	case "Edit", "MultiEdit", "NotebookEdit":
		return with("Editing", file())
	case "Write":
		return with("Writing", file())
	case "Grep":
		if p := str("pattern"); p != "" {
			return "Searching for '" + p + "'"
		}
	case "Glob":
		return with("Finding", str("pattern"))
	case "WebFetch":
		if u, err := url.Parse(str("url")); err == nil && u.Host != "" {
			return "Fetching " + strings.TrimPrefix(u.Host, "www.")
		}
	case "WebSearch":
		if q := str("query"); q != "" {
			return "Searching the web for '" + q + "'"
		}
	case "Bash", "exec":
		if c := str("command"); c != "" {
			return commandPhrase(toolcmd.Command(tool, c))
		}
	case "Skill":
		return with("Using skill", str("skill"))
	case "ToolSearch":
		return "Loading tools"
	}
	if strings.HasPrefix(tool, "mcp__") {
		if parts := strings.SplitN(strings.TrimPrefix(tool, "mcp__"), "__", 2); len(parts) == 2 {
			return "Calling " + parts[0]
		}
	}
	return ""
}

// testCommand is a command line that runs a test suite.
var testCommand = regexp.MustCompile(`^(go(\s+-C\s+\S+)?\s+test|npx\s+vitest|vitest|npm(\s+--prefix\s+\S+)?\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|pytest|python3?\s+-m\s+pytest|cargo\s+test|make(\s+-C\s+\S+)?\s+test|jest|npx\s+jest)\b`)

// commandParts splits a command line into the commands it chains.
var commandParts = regexp.MustCompile(`\n|;|&&|\|\|`)

// setupStep is a part of a command line that only prepares the shell.
var setupStep = regexp.MustCompile(`^((export\s+)?[A-Za-z_][A-Za-z0-9_]*=\S*|cd(\s.*)?|set\s+[-+]\w+)$`)

// commandPhrase names what a command line runs: "Running tests" for a test
// suite, "Running git status" for git, else "Running <program>". Leading
// `cd`, `set -e` and variable assignments are skipped, as the cockpit's
// commandGist skips them.
func commandPhrase(cmd string) string {
	var first string
	for _, part := range commandParts.Split(cmd, -1) {
		if p := strings.TrimSpace(part); p != "" && !setupStep.MatchString(p) {
			first = p
			break
		}
	}
	f := strings.Fields(first)
	// Inline assignments ahead of the program: `GOOS=windows go vet`.
	for len(f) > 0 && setupStep.MatchString(f[0]) && strings.Contains(f[0], "=") {
		f = f[1:]
	}
	if len(f) == 0 {
		return ""
	}
	line := strings.Join(f, " ")
	if testCommand.MatchString(line) {
		return "Running tests"
	}
	prog := baseOf(f[0])
	if prog == "git" {
		for i := 1; i < len(f); i++ {
			if f[i] == "-C" {
				i++
				continue
			}
			if !strings.HasPrefix(f[i], "-") {
				return "Running git " + f[i]
			}
		}
	}
	return "Running " + prog
}
