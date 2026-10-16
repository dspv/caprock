package hermes

import (
	"encoding/json"
	"path/filepath"
	"strings"
)

// contentJSONPrefix marks a content cell Hermes stored as JSON — multimodal
// parts, or a literal string that happened to start with the marker
// (hermes_state_messages._encode_content).
const contentJSONPrefix = "\x00json:"

// decodeContent is a message's text. Plain strings are stored as they are;
// structured content is the marker plus JSON, from which the text parts are
// kept and images and other parts dropped.
func decodeContent(raw string) string {
	if !strings.HasPrefix(raw, contentJSONPrefix) {
		return raw
	}
	body := raw[len(contentJSONPrefix):]
	var s string
	if json.Unmarshal([]byte(body), &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal([]byte(body), &parts) == nil {
		var b strings.Builder
		for _, p := range parts {
			if p.Text == "" {
				continue
			}
			if b.Len() > 0 {
				b.WriteString("\n")
			}
			b.WriteString(p.Text)
		}
		return b.String()
	}
	// Hermes fails closed the same way: an undecodable marker is kept raw.
	return raw
}

// ToolCall is one call an assistant message asked for.
type ToolCall struct {
	ID    string
	Name  string // Hermes's own name: terminal, read_file, patch, …
	Input map[string]any
}

// ToolCalls parses a message's tool_calls column, OpenAI's shape
// ({id, type, function: {name, arguments}}), whose arguments are a JSON string.
// A call that names no tool is skipped; arguments that are not JSON are kept
// under `command`, the shape a shell call takes.
func ToolCalls(raw string) []ToolCall {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "null" {
		return nil
	}
	var calls []struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Function struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		} `json:"function"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal([]byte(raw), &calls); err != nil {
		return nil
	}
	out := make([]ToolCall, 0, len(calls))
	for _, c := range calls {
		name := c.Function.Name
		if name == "" {
			name = c.Name
		}
		if name == "" {
			continue
		}
		args := c.Function.Arguments
		if len(args) == 0 {
			args = c.Arguments
		}
		out = append(out, ToolCall{ID: c.ID, Name: name, Input: arguments(args)})
	}
	return out
}

func arguments(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) == nil && obj != nil {
		return obj
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if s == "" {
			return map[string]any{}
		}
		if json.Unmarshal([]byte(s), &obj) == nil && obj != nil {
			return obj
		}
		return map[string]any{"command": s}
	}
	return map[string]any{}
}

// claudeTools maps Hermes's core tools onto the names every Caprock reader
// already knows (the Claude Code spellings), as OpenCode's importer does. A
// tool not listed keeps its own name.
var claudeTools = map[string]string{
	"terminal":      "Bash",
	"read_file":     "Read",
	"write_file":    "Write",
	"patch":         "Edit",
	"search_files":  "Grep",
	"web_search":    "WebSearch",
	"web_extract":   "WebFetch",
	"delegate_task": "Task",
}

// ToolName is the name Caprock stores for a Hermes tool.
func ToolName(hermes string) string {
	if n, ok := claudeTools[hermes]; ok {
		return n
	}
	return hermes
}

// ToolInput reshapes a call's arguments into a Claude Code hook payload's
// tool_input: Hermes's `path` becomes `file_path` for the file tools (a
// relative one resolved against the session's folder, so per-directory
// attribution places it), and stays `path` for a search. Every other key is
// kept as Hermes wrote it.
func ToolInput(hermes string, in map[string]any, cwd string) map[string]any {
	out := make(map[string]any, len(in)+1)
	for k, v := range in {
		out[k] = v
	}
	switch hermes {
	case "read_file", "write_file", "patch":
		if p, ok := in["path"].(string); ok && p != "" {
			if !filepath.IsAbs(p) && !strings.HasPrefix(p, "/") && !strings.HasPrefix(p, "~") && cwd != "" { // "/…" is absolute where Hermes ran, even read on Windows
				p = filepath.Join(cwd, p)
			}
			out["file_path"] = p
			delete(out, "path")
		}
	}
	return out
}
