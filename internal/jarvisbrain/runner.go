package jarvisbrain

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/hidewin"
)

// Request is one brain run: the instructions, the message with its context
// (prompt.go), and the JSON Schema the answer must match.
type Request struct {
	System string
	Prompt string
	Schema string
}

// Result is one run's answer and what it cost.
type Result struct {
	// JSON is the structured answer.
	JSON json.RawMessage
	// CostUSD is the run's cost as the agent reported it; CostKnown is false
	// when it reported none (Codex).
	CostUSD   float64
	CostKnown bool
}

// Runner makes one brain run on the setting's agent and sign-in. Tests pass
// a function or the fake CLIs.
type Runner interface {
	Run(ctx context.Context, set Setting, r Request) (Result, error)
}

// RunnerFunc adapts a function to a Runner.
type RunnerFunc func(ctx context.Context, set Setting, r Request) (Result, error)

// Run calls f.
func (f RunnerFunc) Run(ctx context.Context, set Setting, r Request) (Result, error) {
	return f(ctx, set, r)
}

// DefaultTimeout bounds one run.
const DefaultTimeout = 90 * time.Second

// ClaudeModel is the model the brain asks Claude Code for: an alias
// `claude --help` names ("Provide an alias for the latest model (e.g.
// 'fable', 'opus', or 'sonnet')"). Routing and a routine question need no
// more, and the person's plan window feels it less than their default.
const ClaudeModel = "sonnet"

// CLIRunner runs the user's own Claude Code or Codex headless, with no tool,
// from an empty folder of Caprock's, on the chosen sign-in.
type CLIRunner struct {
	// Binary is the agent's executable, "" when it is not installed.
	Binary func(agent string) string
	// Env is the environment the run gets: the user's login shell's, with
	// CLAUDE_CONFIG_DIR or CODEX_HOME pointed at the chosen sign-in.
	Env func(set Setting) ([]string, error)
	// Dir is an empty working folder of Caprock's.
	Dir     string
	Timeout time.Duration
}

// claudeSettings turns every hook off, Caprock's shim among them, so a run
// is never recorded as a session (as Second Brain's, internal/brain).
const claudeSettings = `{"disableAllHooks": true}` + "\n"

// codexDisabled are the Codex features turned off for a run: every tool
// that runs a command, reads a file, browses or reaches another agent (the
// list Caprock Mail's triage uses, internal/mail/ai).
var codexDisabled = []string{
	"shell_tool", "unified_exec", "code_mode", "code_mode_host", "hooks", "plugins", "apps",
	"multi_agent", "multi_agent_v2", "image_generation", "view_image", "browser_use",
	"computer_use", "skill_search", "tool_suggest", "goals", "memories",
}

// Argv is the command line and the stdin for one run. files holds the paths
// the run uses inside Dir: "settings" (Claude Code's), "schema" and "out"
// (Codex's). batch is a Windows .cmd shim, whose command line cannot carry
// JSON: the instructions and the schema then go to stdin.
//
// Every flag was read from `claude --help` of Claude Code 2.1.325 and
// `codex exec --help` of codex-cli 0.163.0 on 2026-11-16; neither CLI was
// run against an account to write this.
//
// claude: `-p` (--print) is the non-interactive mode, the prompt read from
// stdin; `--output-format json` prints one result with `structured_output`,
// `total_cost_usd` and `is_error`; `--json-schema` makes the answer match
// the schema; `--tools ""` ("Use \"\" to disable all tools") leaves the
// model no tool; `--strict-mcp-config` with no --mcp-config loads no MCP
// server; `--no-session-persistence` writes no transcript, so Caprock's own
// ingest never sees the run as a session; `--setting-sources local` from an
// empty folder and `--settings` holding `disableAllHooks` keep the user's
// settings, hooks, plugins and memory files out — the login is still the
// one CLAUDE_CONFIG_DIR names; `--system-prompt` the instructions;
// `--model sonnet`.
//
// codex: `exec` is the non-interactive mode, `-` reads the prompt from
// stdin; `--ephemeral` ("Run without persisting session files to disk");
// `--ignore-user-config` ("Do not load $CODEX_HOME/config.toml; auth still
// uses CODEX_HOME") and `--ignore-rules`; `--sandbox read-only` and the
// features above leave nothing that can act; `-c web_search="disabled"`;
// `--skip-git-repo-check` because the folder is no repository;
// `--output-schema <FILE>` the answer's shape; `-o` (--output-last-message)
// writes the final answer to a file; `--color never`.
func Argv(agent string, r Request, batch bool, files map[string]string) ([]string, string, error) {
	switch agent {
	case AgentClaude:
		args := []string{"-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence",
			"--setting-sources", "local", "--settings", files["settings"], "--model", ClaudeModel}
		if batch {
			return args, r.System + "\n\nAnswer with only this JSON, nothing around it: " + r.Schema + "\n\n" + r.Prompt, nil
		}
		return append(args, "--system-prompt", r.System, "--json-schema", r.Schema), r.Prompt, nil
	case AgentCodex:
		args := []string{"exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
			"--sandbox", "read-only", "--color", "never", "-c", "web_search=disabled"}
		for _, f := range codexDisabled {
			args = append(args, "--disable", f)
		}
		args = append(args, "--output-schema", files["schema"], "-o", files["out"], "-")
		return args, r.System + "\n\n" + r.Prompt, nil
	}
	return nil, "", fmt.Errorf("the brain runs on claude or codex, not %q", agent)
}

// isBatch reports whether a binary is a Windows .cmd or .bat shim.
func isBatch(p string) bool {
	ext := strings.ToLower(filepath.Ext(p))
	return ext == ".cmd" || ext == ".bat"
}

// Run makes one run.
func (c CLIRunner) Run(ctx context.Context, set Setting, r Request) (Result, error) {
	agent := set.Agent
	name := map[string]string{AgentClaude: "Claude Code", AgentCodex: "Codex"}[agent]
	if name == "" {
		return Result{}, errors.New("the brain is off")
	}
	bin := ""
	if c.Binary != nil {
		bin = c.Binary(agent)
	}
	if bin == "" {
		return Result{}, fmt.Errorf("%s was not found on this computer", name)
	}
	if err := os.MkdirAll(c.Dir, 0o700); err != nil {
		return Result{}, err
	}
	var env []string
	if c.Env != nil {
		e, err := c.Env(set)
		if err != nil {
			return Result{}, err
		}
		env = e
	}
	files := map[string]string{}
	switch agent {
	case AgentClaude:
		files["settings"] = filepath.Join(c.Dir, "claude-settings.json")
		if err := os.WriteFile(files["settings"], []byte(claudeSettings), 0o600); err != nil {
			return Result{}, err
		}
	case AgentCodex:
		sf, err := os.CreateTemp(c.Dir, "schema-*.json")
		if err != nil {
			return Result{}, err
		}
		_, werr := sf.WriteString(r.Schema)
		_ = sf.Close()
		defer os.Remove(sf.Name())
		if werr != nil {
			return Result{}, werr
		}
		of, err := os.CreateTemp(c.Dir, "answer-*.json")
		if err != nil {
			return Result{}, err
		}
		_ = of.Close()
		defer os.Remove(of.Name())
		files["schema"], files["out"] = sf.Name(), of.Name()
	}
	args, stdin, err := Argv(agent, r, isBatch(bin), files)
	if err != nil {
		return Result{}, err
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := hidewin.CommandContext(cctx, bin, args...)
	cmd.Dir = c.Dir
	if len(env) > 0 {
		cmd.Env = env
	}
	cmd.Stdin = strings.NewReader(stdin)
	// A node CLI's children can hold the pipes after it is killed.
	cmd.WaitDelay = 5 * time.Second
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	runErr := cmd.Run()
	if cctx.Err() != nil && ctx.Err() == nil {
		return Result{}, fmt.Errorf("%s did not answer within %s", name, timeout)
	}
	if agent == AgentCodex {
		return parseCodex(files["out"], errb.String(), runErr)
	}
	return parseClaude(out.Bytes(), errb.String(), runErr)
}

// parseClaude reads `claude -p --output-format json`: the structured
// output, else the first JSON object in the text, and the cost.
func parseClaude(stdout []byte, stderr string, runErr error) (Result, error) {
	var c struct {
		IsError          bool            `json:"is_error"`
		Subtype          string          `json:"subtype"`
		Result           string          `json:"result"`
		StructuredOutput json.RawMessage `json:"structured_output"`
		TotalCostUSD     *float64        `json:"total_cost_usd"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(stdout), &c); err != nil {
		if runErr != nil {
			return Result{}, failure("claude", runErr, stderr)
		}
		return Result{}, fmt.Errorf("claude's answer is not JSON: %s", clip(string(stdout), 200))
	}
	var res Result
	if c.TotalCostUSD != nil {
		res.CostUSD, res.CostKnown = *c.TotalCostUSD, true
	}
	if c.IsError {
		return res, fmt.Errorf("claude: %s", clip(strings.TrimSpace(c.Subtype+" "+c.Result), 300))
	}
	raw := c.StructuredOutput
	if len(raw) == 0 || string(raw) == "null" {
		raw = json.RawMessage(firstObject(c.Result))
	}
	if !json.Valid(raw) {
		return res, fmt.Errorf("claude did not answer in the expected shape: %s", clip(c.Result, 200))
	}
	res.JSON = raw
	return res, nil
}

// parseCodex reads the answer `codex exec -o` wrote. Codex reports no cost.
func parseCodex(path, stderr string, runErr error) (Result, error) {
	if runErr != nil {
		return Result{}, failure("codex", runErr, stderr)
	}
	b, err := os.ReadFile(path)
	if err != nil || strings.TrimSpace(string(b)) == "" {
		if msg := lastLine(stderr); msg != "" {
			return Result{}, fmt.Errorf("codex returned nothing: %s", clip(msg, 300))
		}
		return Result{}, errors.New("codex returned nothing")
	}
	raw := json.RawMessage(firstObject(string(b)))
	if !json.Valid(raw) {
		return Result{}, fmt.Errorf("codex did not answer in the expected shape: %s", clip(string(b), 200))
	}
	return Result{JSON: raw}, nil
}

func failure(name string, runErr error, stderr string) error {
	msg := lastLine(stderr)
	if msg == "" {
		msg = runErr.Error()
	}
	return fmt.Errorf("%s: %s", name, clip(msg, 300))
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(lines[i]); l != "" {
			return l
		}
	}
	return ""
}

// firstObject returns the first balanced {...} in s, or s itself.
func firstObject(s string) string {
	start := strings.IndexByte(s, '{')
	if start < 0 {
		return s
	}
	depth, inStr, esc := 0, false, false
	for i := start; i < len(s); i++ {
		ch := s[i]
		switch {
		case esc:
			esc = false
		case ch == '\\' && inStr:
			esc = true
		case ch == '"':
			inStr = !inStr
		case inStr:
		case ch == '{':
			depth++
		case ch == '}':
			depth--
			if depth == 0 {
				return s[start : i+1]
			}
		}
	}
	return s[start:]
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
