package cursor

import (
	"os"
	"path"
	"path/filepath"
	"strings"
)

// claudeTools maps Cursor's tool names onto the spellings every Caprock
// reader already knows (Claude Code's), as the OpenCode and Hermes importers
// do. The editor's names are the ones counted on the owner's state.vscdb on
// 2026-11-16 (run_terminal_cmd, search_replace, read_file, grep, write…);
// the hook plane's are the tool types cursor.com/docs/agent/hooks lists
// (Shell, Read, Write, Grep, Delete, Task). A tool not listed keeps its name.
var claudeTools = map[string]string{
	"run_terminal_cmd":   "Bash",
	"Shell":              "Bash",
	"read_file":          "Read",
	"write":              "Write",
	"search_replace":     "Edit",
	"edit_file":          "Edit",
	"apply_patch":        "Edit",
	"grep":               "Grep",
	"grep_search":        "Grep",
	"glob_file_search":   "Glob",
	"file_search":        "Glob",
	"list_dir":           "LS",
	"delete_file":        "Delete",
	"web_search":         "WebSearch",
	"todo_write":         "TodoWrite",
	"codebase_search":    "CodebaseSearch",
	"read_lints":         "ReadLints",
	"create_diagram":     "Diagram",
	"update_memory":      "Memory",
	"MultiEdit":          "MultiEdit",
	"Read":               "Read",
	"Write":              "Write",
	"Grep":               "Grep",
	"Delete":             "Delete",
	"Task":               "Task",
	"edit_file_v2_write": "Write",
	// One call each on the owner's machine (2026-11-17): Cursor's newer
	// edit tool, and reapply, which applies an edit again.
	"edit_file_v2_search_replace": "Edit",
	"reapply":                     "Edit",
}

// ToolName is the name Caprock stores for a Cursor tool.
func ToolName(cursor string) string {
	if n, ok := claudeTools[cursor]; ok {
		return n
	}
	return cursor
}

// callName is the name Caprock stores for one call: ToolName, except that an
// MCP call is spelled as Claude Code spells one, mcp__<server>__<tool>, so it
// groups with the same server's calls from any agent. Cursor names an MCP
// call mcp_<server>_<tool> (or just "mcp"), and both parts may hold "_" or
// "-", so the split is taken from the server and tool Cursor recorded beside
// it (reviewData, params); without them the name is kept as Cursor wrote it.
func callName(t *Tool) string {
	if t.MCPServer != "" && t.MCPTool != "" && strings.HasPrefix(t.Name, "mcp") {
		return "mcp__" + t.MCPServer + "__" + t.MCPTool
	}
	return ToolName(t.Name)
}

// pathKeys are the arguments Cursor's file tools name a file or folder by.
var pathKeys = []string{"file_path", "target_file", "path", "target_directory", "relative_workspace_path"}

// ToolInput reshapes a call's arguments into a Claude Code hook payload's
// tool_input: the file a file tool names becomes `file_path` (a relative
// path resolved against the chat's folder, so per-directory attribution
// places it), `contents` becomes `content`, and every other key is kept.
func ToolInput(cursor string, in map[string]any, cwd string) map[string]any {
	out := make(map[string]any, len(in)+1)
	for k, v := range in {
		out[k] = v
	}
	switch ToolName(cursor) {
	case "Read", "Write", "Edit", "Delete", "MultiEdit":
		for _, k := range []string{"file_path", "target_file"} {
			if p, ok := in[k].(string); ok && p != "" {
				out["file_path"] = absolute(p, cwd)
				if k != "file_path" {
					delete(out, k)
				}
				break
			}
		}
		if c, ok := in["contents"]; ok {
			out["content"] = c
			delete(out, "contents")
		}
	}
	return out
}

// absolute resolves p against cwd unless it is absolute where Cursor ran it
// ("/…" is, even read on Windows).
//
// Cursor often writes a relative path from the folder above the workspace:
// "kgpu/src/main.jsx" in a chat whose folder is …/kgpu. Joined as it is, the
// edit was filed under …/kgpu/kgpu/src (on the owner's machine 284 of 362
// edit_file paths were relative, 2026-11-17). So a leading segment that names
// the folder itself is dropped — unless the folder really holds a subfolder
// of that name.
func absolute(p, cwd string) string {
	if filepath.IsAbs(p) || strings.HasPrefix(p, "/") || strings.HasPrefix(p, "~") || cwd == "" {
		return p
	}
	slash := strings.HasPrefix(cwd, "/") && !strings.Contains(cwd, `\`)
	join, base := filepath.Join, filepath.Base
	if slash {
		join, base = path.Join, path.Base
	}
	rel := strings.TrimPrefix(strings.ReplaceAll(p, `\`, "/"), "./")
	if first, rest, ok := strings.Cut(rel, "/"); ok && rest != "" && first == base(cwd) {
		if _, err := osStat(join(cwd, first)); err != nil {
			rel = rest
		}
	}
	if !slash {
		rel = filepath.FromSlash(rel)
	}
	return join(cwd, rel)
}

// pathHint is an absolute path a tool call names, "" when it names none.
func pathHint(t *Tool) string {
	if t == nil {
		return ""
	}
	for _, k := range pathKeys {
		if p, ok := t.Args[k].(string); ok && (filepath.IsAbs(p) || strings.HasPrefix(p, "/")) {
			return p
		}
	}
	return ""
}

// repoOf walks up from a file's folder to the nearest one holding .git, and
// returns the file's own folder when none does or the path is gone.
// A path in slash form (macOS, Linux, a WSL or remote folder) is walked in
// slash form on every OS, so it is never rewritten with backslashes.
func repoOf(p string) string {
	dirOf, join := filepath.Dir, filepath.Join
	if strings.HasPrefix(p, "/") && !strings.Contains(p, `\`) {
		dirOf, join = path.Dir, path.Join
	}
	dir := dirOf(p)
	for d := dir; ; {
		if _, err := osStat(join(d, ".git")); err == nil {
			return d
		}
		up := dirOf(d)
		if up == d {
			break
		}
		d = up
	}
	return dir
}

// osStat is os.Stat, a variable so a test can say which folders hold .git.
var osStat = os.Stat
