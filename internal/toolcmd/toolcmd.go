// Package toolcmd reads the command a tool call ran out of the input it was
// stored with, for every place in the daemon that describes a call in one
// line: the Now screen's phrase, a notification's subject, a loop alert's
// sample, a subagent's current call.
//
// Codex is the reason it exists. Its `exec` tool does not run a command: it
// runs a JavaScript script that calls Codex's own tools —
// `tools.exec_command({cmd: "git status"})` for a shell command,
// `tools.apply_patch(…)` for an edit — and the script is what the call
// carries under `command`. Shown as sent, every one of those lines read as a
// wall of JavaScript. The chat reads the command out (ui/src/lib/chat.ts
// codexScript); this is the same reading for the daemon, and the two must say
// the same thing (testdata in toolcmd_test.go and chat.test.ts match).
package toolcmd

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

var (
	toolCall  = regexp.MustCompile(`tools\.([A-Za-z0-9_]+)\(`)
	cmdKey    = regexp.MustCompile(`["']?cmd["']?\s*:\s*`)
	patchFile = regexp.MustCompile(`\*\*\* (?:Add|Update|Delete) File: ([^\n\\]+)`)
)

// Script is what a Codex `exec` script ran, as one line: the first line of
// the shell command it passed to `tools.exec_command`, `apply_patch <file>`
// for a patch, else the name of the tool it called (`web__run`). ok is false
// when the script calls no tool at all.
func Script(script string) (line string, ok bool) {
	tool, arg, ok := ScriptCall(script)
	switch {
	case !ok:
		return "", false
	case arg == "":
		return tool, true
	case tool == "apply_patch":
		return "apply_patch " + arg, true
	}
	return arg, true
}

// ScriptCall is the first of Codex's tools a script calls and what it was
// given, where that can be read: the first line of `exec_command`'s `cmd`, the
// file an `apply_patch` patches; "" otherwise. ok is false when the script
// calls no tool.
func ScriptCall(script string) (tool, arg string, ok bool) {
	m := toolCall.FindStringSubmatchIndex(script)
	if m == nil {
		return "", "", false
	}
	tool = script[m[2]:m[3]]
	switch tool {
	case "exec_command":
		if k := cmdKey.FindStringIndex(script[m[0]:]); k != nil {
			if cmd, ok := jsString(script, m[0]+k[1]); ok {
				if cmd = strings.TrimSpace(cmd); cmd != "" {
					return tool, firstLine(cmd), true
				}
			}
		}
	case "apply_patch":
		if f := patchFile.FindStringSubmatch(script); f != nil {
			return tool, strings.TrimSpace(f[1]), true
		}
	}
	return tool, "", true
}

// Command is the command line a call's stored `command` stands for: for
// Codex's `exec`, what its script ran (Script); a Codex input stored before
// the daemon unwrapped it — the arguments' JSON string under `command`, a
// `shell` argv inside — read as it is stored now; anything else as it is.
func Command(tool, command string) string {
	if tool == "Bash" {
		// Claude Code's own: a command, whatever it looks like.
		return command
	}
	command = unwrap(command)
	if tool == "exec" {
		if line, ok := Script(command); ok {
			return line
		}
	}
	return command
}

// unwrap reads `{"command": …}` held as a string — how Codex rows stored
// before 2026-10-09 carry a function call's arguments — as the command it
// holds, an argv joined into its line. Anything else is returned unchanged.
func unwrap(command string) string {
	t := strings.TrimSpace(command)
	if !strings.HasPrefix(t, "{") {
		return command
	}
	var inner struct {
		Command json.RawMessage `json:"command"`
	}
	if json.Unmarshal([]byte(t), &inner) != nil || len(inner.Command) == 0 {
		return command
	}
	var s string
	if json.Unmarshal(inner.Command, &s) == nil {
		return s
	}
	var argv []string
	if json.Unmarshal(inner.Command, &argv) == nil && len(argv) > 0 {
		return ShellLine(argv)
	}
	return command
}

// ShellLine is the line an argv runs: the script of `<shell> -lc <script>`,
// how Codex runs nearly everything, else the words joined with spaces.
func ShellLine(argv []string) string {
	if len(argv) == 3 && (argv[1] == "-lc" || argv[1] == "-c") {
		return argv[2]
	}
	return strings.Join(argv, " ")
}

// jsString decodes the JavaScript string literal that opens at src[at].
func jsString(src string, at int) (string, bool) {
	if at >= len(src) {
		return "", false
	}
	q := src[at]
	if q != '"' && q != '\'' && q != '`' {
		return "", false
	}
	var b strings.Builder
	for k := at + 1; k < len(src); k++ {
		c := src[k]
		if c == q {
			return b.String(), true
		}
		if c != '\\' {
			b.WriteByte(c)
			continue
		}
		k++
		if k >= len(src) {
			return "", false
		}
		switch n := src[k]; n {
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case 'r':
			b.WriteByte('\r')
		case 'u':
			if k+5 <= len(src) {
				if v, err := strconv.ParseUint(src[k+1:k+5], 16, 32); err == nil {
					b.WriteRune(rune(v))
					k += 4
					continue
				}
			}
			b.WriteByte(n)
		default:
			b.WriteByte(n)
		}
	}
	return "", false
}

// firstLine is s up to its first newline.
func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
