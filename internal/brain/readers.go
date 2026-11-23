package brain

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/hidewin"
)

// The agents Second Brain can read with (ADR-103): whichever coding CLI the
// user has and is signed in to. Each id is the agent's id in `sessions.agent`
// and in internal/agents.
const (
	ReaderClaude = "claude"
	ReaderCodex  = "codex"
	ReaderCursor = "cursor"
	ReaderGemini = "gemini"
	// ReaderAuto is the setting that picks one by itself (PickReader).
	ReaderAuto = "auto"
)

// ReaderOrder is every reader, in the order a tie is broken and the
// settings list them: Claude Code first.
var ReaderOrder = []string{ReaderClaude, ReaderCodex, ReaderCursor, ReaderGemini}

// ReaderLabel is a reader's name as a person says it.
func ReaderLabel(id string) string {
	switch id {
	case ReaderClaude:
		return "Claude Code"
	case ReaderCodex:
		return "Codex"
	case ReaderCursor:
		return "Cursor"
	case ReaderGemini:
		return "Gemini CLI"
	}
	return id
}

// IsReader reports whether id names a reader.
func IsReader(id string) bool {
	for _, r := range ReaderOrder {
		if r == id {
			return true
		}
	}
	return false
}

// ReportsTokens and ReportsCost say what each reader's headless answer
// carries, from its own documentation (ADR-103): Claude Code reports tokens
// and a cost, Codex and Gemini CLI tokens only, Cursor neither. Where tokens
// are not reported nothing is estimated: the read is recorded as not
// reported and counted against the daily reads limit instead.
func ReportsTokens(id string) bool { return id != ReaderCursor }

// ReportsCost: see ReportsTokens.
func ReportsCost(id string) bool { return id == ReaderClaude }

// ErrNoReader is returned by a runner whose agent is not installed.
var ErrNoReader = errors.New("the agent was not found on this computer")

// structuredPrompt is the whole of a request as one text for a CLI that
// takes no separate system prompt or schema: the instructions, the shape
// of the answer, then the transcript. As ClaudeRunner sends it through a
// Windows .cmd shim.
func structuredPrompt(r Request) string {
	if r.Plain {
		return r.System + "\n\n" + r.Prompt
	}
	schema := Schema
	if r.Schema != "" {
		schema = r.Schema
	}
	return r.System + "\n\nAnswer with only this JSON, nothing around it: " + schema + "\n\n" + r.Prompt
}

// fromText fills a result's memories (or JSON) from the answer's text, as
// ParseResult does for claude's text when it gave no structured output.
func fromText(name string, r Request, res Result) (Result, error) {
	if r.Plain {
		if strings.TrimSpace(res.Text) == "" {
			return res, fmt.Errorf("%s returned nothing", name)
		}
		return res, nil
	}
	raw := json.RawMessage(firstObject(res.Text))
	res.JSON = raw
	var body struct {
		Memories []Memory `json:"memories"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		if r.Schema != "" && json.Valid(raw) {
			return res, nil
		}
		return res, fmt.Errorf("%s did not answer in the expected shape: %s", name, clip(res.Text, 200))
	}
	res.Memories = body.Memories
	return res, nil
}

// cliCall is what every runner shares: the binary, the user's login-shell
// environment, a working folder of Caprock's and a timeout.
type cliCall struct {
	name    string
	bin     string
	args    []string
	env     []string
	dir     string
	stdin   string
	timeout time.Duration
}

// run starts the CLI with the prompt on stdin, bounded by the timeout, and
// returns stdout, stderr and the run's error (a timeout said as one).
func (c cliCall) run(ctx context.Context) ([]byte, string, error) {
	timeout := c.timeout
	if timeout <= 0 {
		timeout = 3 * time.Minute
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := hidewin.CommandContext(cctx, c.bin, c.args...)
	cmd.Dir = c.dir
	if len(c.env) > 0 {
		cmd.Env = c.env
	}
	cmd.Stdin = strings.NewReader(c.stdin)
	// A node CLI's children can hold the pipes after it is killed; do not
	// wait on them forever.
	cmd.WaitDelay = 5 * time.Second
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	if cctx.Err() != nil && ctx.Err() == nil {
		return out.Bytes(), errb.String(), fmt.Errorf("%s did not answer within %s", c.name, timeout)
	}
	return out.Bytes(), errb.String(), err
}

func failure(name string, runErr error, stderr string, stdout []byte) error {
	msg := lastLine(stderr)
	if msg == "" {
		msg = lastLine(string(stdout))
	}
	if msg == "" {
		return fmt.Errorf("%s: %w", name, runErr)
	}
	return fmt.Errorf("%s: %w: %s", name, runErr, clip(msg, 300))
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

// callDir is a fresh empty folder for one call under the runner's own, so
// nothing a CLI might leave in its working folder outlives the call.
func callDir(base string) (string, func(), error) {
	if err := os.MkdirAll(base, 0o700); err != nil {
		return "", nil, err
	}
	d, err := os.MkdirTemp(base, "read-")
	if err != nil {
		return "", nil, err
	}
	return d, func() { _ = os.RemoveAll(d) }, nil
}

// CodexRunner runs `codex exec`, Codex's non-interactive mode. The flags,
// from developers.openai.com/codex (Non-interactive mode, read 2026-11-23)
// and the same set Mail's assistant passes (internal/mail/ai/cli.go, read
// from codex-cli 0.161.0's --help on 2026-10-15):
//
//   - `exec … -`: non-interactive, the prompt read from stdin.
//   - `--json`: stdout is JSON Lines; `turn.completed` carries `usage`
//     ({input_tokens, cached_input_tokens, output_tokens}; cached is part of
//     input). No cost is reported.
//   - `-o <file>`: the final message is also written to that file.
//   - `--sandbox read-only`, and every tool feature off (`--disable …`,
//     `-c web_search=disabled`): nothing can be run, written or fetched.
//   - `--ephemeral`: no session file, so Caprock's own ingest never sees
//     the call; `--ignore-user-config --ignore-rules`: the user's
//     config.toml (MCP servers, hooks, profiles) is not loaded — the login
//     still is; `--skip-git-repo-check`: the folder is no repository.
//   - `-m`: the user's model for Codex, else Codex's own default.
//
// `--output-schema` is not used: Codex holds it to OpenAI's strict schema
// rules, which Schema does not follow, so the shape goes into the prompt
// and the answer is read from its text, as through a Windows .cmd shim.
type CodexRunner struct {
	Binary  func() string
	Env     func() []string
	Dir     string
	Timeout time.Duration
}

// CodexDisabled are the Codex features turned off for a read: every tool
// that runs a command, reads a file, browses or reaches another agent —
// the list Mail's assistant uses (internal/mail/ai/cli.go).
var CodexDisabled = []string{
	"shell_tool", "unified_exec", "code_mode", "code_mode_host", "hooks", "plugins", "apps",
	"multi_agent", "multi_agent_v2", "image_generation", "view_image", "browser_use",
	"computer_use", "skill_search", "tool_suggest", "goals", "memories",
}

// CodexArgv is the command line for one read; out is the answer file.
func CodexArgv(model, out string) []string {
	args := []string{"exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
		"--sandbox", "read-only", "--color", "never", "-c", "web_search=disabled"}
	for _, f := range CodexDisabled {
		args = append(args, "--disable", f)
	}
	if model != "" {
		args = append(args, "-m", model)
	}
	return append(args, "-o", out, "-")
}

// Run makes one call.
func (c CodexRunner) Run(ctx context.Context, r Request) (Result, error) {
	bin := call(c.Binary)
	if bin == "" {
		return Result{}, fmt.Errorf("codex: %w", ErrNoReader)
	}
	dir, done, err := callDir(c.Dir)
	if err != nil {
		return Result{}, err
	}
	defer done()
	out := filepath.Join(dir, "answer.txt")
	stdout, stderr, runErr := cliCall{name: "codex", bin: bin, args: CodexArgv(r.Model, out), env: call(c.Env), dir: dir,
		stdin: structuredPrompt(r), timeout: c.Timeout}.run(ctx)
	last, _ := os.ReadFile(out)
	return ParseCodex(stdout, string(last), stderr, runErr, r)
}

// ParseCodex reads `codex exec --json`'s events and the final message the
// `-o` file holds: the answer, and the tokens `turn.completed` reported.
func ParseCodex(stdout []byte, last, stderr string, runErr error, r Request) (Result, error) {
	res := Result{Model: r.Model}
	var failed, agentText string
	sc := bufio.NewScanner(bytes.NewReader(stdout))
	sc.Buffer(make([]byte, 0, 64<<10), 16<<20)
	for sc.Scan() {
		var ev struct {
			Type  string `json:"type"`
			Usage *struct {
				InputTokens  int64 `json:"input_tokens"`
				OutputTokens int64 `json:"output_tokens"`
			} `json:"usage"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
			Message string `json:"message"`
			Item    *struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"item"`
		}
		if json.Unmarshal(bytes.TrimSpace(sc.Bytes()), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "turn.completed":
			if ev.Usage != nil {
				res.TokensIn += ev.Usage.InputTokens
				res.TokensOut += ev.Usage.OutputTokens
				res.UsageReported = true
			}
		case "turn.failed":
			if ev.Error != nil {
				failed = ev.Error.Message
			}
		case "error":
			if ev.Message != "" {
				failed = ev.Message
			}
		case "item.completed":
			if ev.Item != nil && ev.Item.Type == "agent_message" {
				agentText = ev.Item.Text
			}
		}
	}
	if failed != "" {
		return res, fmt.Errorf("codex: %s", clip(failed, 300))
	}
	if runErr != nil {
		return res, failure("codex", runErr, stderr, nil)
	}
	res.Text = strings.TrimSpace(last)
	if res.Text == "" {
		res.Text = strings.TrimSpace(agentText)
	}
	return fromText("codex", r, res)
}

// GeminiRunner runs `gemini -p`, Gemini CLI's non-interactive mode. The
// flags, from Gemini CLI's docs/cli/cli-reference.md and headless.md on
// GitHub (google-gemini/gemini-cli, read 2026-11-23) and the set Mail's assistant passes (internal/mail/ai/cli.go,
// read from Gemini CLI 0.62.0's --help on 2026-10-15):
//
//   - `-p <text>`: non-interactive; the text is appended to stdin, where
//     the real prompt is.
//   - `-o json`: one JSON object, `{response, stats, error?}`; `stats.models`
//     is per model `{tokens: {prompt, candidates, cached, thoughts, …}}`
//     (Gemini CLI 0.62.0's uiTelemetry). No cost is reported.
//   - `--approval-mode plan`: its read-only mode; a system settings file
//     (GEMINI_CLI_SYSTEM_SETTINGS_PATH, which overrides the user's) turns
//     hooks, skills and every built-in tool off; `-e none` loads no
//     extension and `--allowed-mcp-server-names caprock-none` no MCP server.
//   - `--skip-trust`: trusts the empty folder for this call only.
//   - `-m`: the user's model for Gemini, else its own default.
type GeminiRunner struct {
	Binary  func() string
	Env     func() []string
	Dir     string
	Timeout time.Duration
}

// GeminiSettings is the system settings file a read runs with.
const GeminiSettings = `{"hooksConfig": {"enabled": false}, "tools": {"core": []}, "skills": {"enabled": false}}` + "\n"

// geminiPrompt is the -p text; it holds nothing a batch shim would mangle.
const geminiPrompt = "Answer as instructed above."

// GeminiArgv is the command line for one read.
func GeminiArgv(model string) []string {
	args := []string{"-p", geminiPrompt, "-o", "json", "--approval-mode", "plan", "--skip-trust",
		"-e", "none", "--allowed-mcp-server-names", "caprock-none"}
	if model != "" {
		args = append(args, "-m", model)
	}
	return args
}

// Run makes one call.
func (g GeminiRunner) Run(ctx context.Context, r Request) (Result, error) {
	bin := call(g.Binary)
	if bin == "" {
		return Result{}, fmt.Errorf("gemini: %w", ErrNoReader)
	}
	dir, done, err := callDir(g.Dir)
	if err != nil {
		return Result{}, err
	}
	defer done()
	settings := filepath.Join(dir, "gemini-settings.json")
	if err := os.WriteFile(settings, []byte(GeminiSettings), 0o600); err != nil {
		return Result{}, err
	}
	env := call(g.Env)
	if env == nil {
		env = os.Environ()
	}
	env = append(append([]string(nil), env...), "GEMINI_CLI_SYSTEM_SETTINGS_PATH="+settings)
	stdout, stderr, runErr := cliCall{name: "gemini", bin: bin, args: GeminiArgv(r.Model), env: env, dir: dir,
		stdin: structuredPrompt(r), timeout: g.Timeout}.run(ctx)
	return ParseGemini(stdout, stderr, runErr, r)
}

// ParseGemini reads `gemini -o json`: the response, or error.message, and
// the tokens per model.
func ParseGemini(stdout []byte, stderr string, runErr error, r Request) (Result, error) {
	res := Result{Model: r.Model}
	var g struct {
		Response *string `json:"response"`
		Stats    struct {
			Models map[string]struct {
				Tokens struct {
					Prompt     int64 `json:"prompt"`
					Candidates int64 `json:"candidates"`
					Thoughts   int64 `json:"thoughts"`
				} `json:"tokens"`
			} `json:"models"`
		} `json:"stats"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	text := strings.TrimSpace(string(stdout))
	if text == "" {
		text = stderr
	}
	if err := json.Unmarshal([]byte(outerObject(text)), &g); err != nil {
		if runErr != nil {
			return res, failure("gemini", runErr, stderr, stdout)
		}
		return res, fmt.Errorf("gemini's answer is not JSON: %s", clip(string(stdout), 200))
	}
	var most int64
	for name, m := range g.Stats.Models {
		res.TokensIn += m.Tokens.Prompt
		res.TokensOut += m.Tokens.Candidates + m.Tokens.Thoughts
		res.UsageReported = true
		if n := m.Tokens.Prompt + m.Tokens.Candidates; n > most || res.Model == "" {
			most, res.Model = n, name
		}
	}
	if g.Error != nil && g.Error.Message != "" {
		return res, fmt.Errorf("gemini: %s", clip(strings.TrimSpace(g.Error.Message), 300))
	}
	if runErr != nil {
		return res, failure("gemini", runErr, stderr, nil)
	}
	if g.Response != nil {
		res.Text = strings.TrimSpace(*g.Response)
	}
	return fromText("gemini", r, res)
}

// outerObject is the span from the first '{' to the last '}' of s: a CLI
// may print a warning line before its JSON.
func outerObject(s string) string {
	i, j := strings.IndexByte(s, '{'), strings.LastIndexByte(s, '}')
	if i < 0 || j < i {
		return s
	}
	return s[i : j+1]
}

// CursorRunner runs `cursor-agent -p`, Cursor CLI's print mode. The flags,
// from cursor.com/docs/cli (Parameters, Output format, Headless, Overview;
// read 2026-11-23) and the cursor-agent 2025.09.12 bundle's own options:
//
//   - `-p --output-format json`: one JSON object, `{type, subtype,
//     is_error, duration_ms, duration_api_ms, result, session_id,
//     request_id?}` — no tokens and no cost ("The output includes no token
//     usage or cost fields"); a failure is a non-zero exit with the error
//     on stderr.
//   - the prompt on stdin: with stdin not a terminal, print mode reads it
//     and it replaces the prompt arguments (cursor-agent 2025.09.12).
//   - `--mode ask`: "Read-only exploration without making changes";
//     `--trust`: trusts the folder without a prompt, headless only;
//     `--workspace <dir>`: the empty folder of the call. A CLI from before
//     these refuses them as unknown options; the read is then made again
//     without them (and the runner remembers), in that call's own empty
//     folder, removed afterwards, and without `--force`, so anything that
//     would need approval — a command, an MCP tool, a web fetch — is
//     rejected.
//   - `--model`: the user's model for Cursor, else the account's default.
type CursorRunner struct {
	Binary  func() string
	Env     func() []string
	Dir     string
	Timeout time.Duration

	mu sync.Mutex
	// old is set once the CLI refused the newer flags.
	old bool
}

// CursorArgv is the command line for one read; old leaves out the flags a
// CLI from before them refuses.
func CursorArgv(model, dir string, old bool) []string {
	args := []string{"-p", "--output-format", "json"}
	if !old {
		args = append(args, "--mode", "ask", "--trust", "--workspace", dir)
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	return args
}

// Run makes one call.
func (c *CursorRunner) Run(ctx context.Context, r Request) (Result, error) {
	bin := call(c.Binary)
	if bin == "" {
		return Result{}, fmt.Errorf("cursor-agent: %w", ErrNoReader)
	}
	dir, done, err := callDir(c.Dir)
	if err != nil {
		return Result{}, err
	}
	defer done()
	c.mu.Lock()
	old := c.old
	c.mu.Unlock()
	cc := cliCall{name: "cursor-agent", bin: bin, env: call(c.Env), dir: dir, stdin: structuredPrompt(r), timeout: c.Timeout}
	cc.args = CursorArgv(r.Model, dir, old)
	stdout, stderr, runErr := cc.run(ctx)
	if runErr != nil && !old && strings.Contains(strings.ToLower(stderr), "unknown option") {
		c.mu.Lock()
		c.old = true
		c.mu.Unlock()
		cc.args = CursorArgv(r.Model, dir, true)
		stdout, stderr, runErr = cc.run(ctx)
	}
	return ParseCursor(stdout, stderr, runErr, r)
}

// ParseCursor reads `cursor-agent -p --output-format json`: the result's
// text. Cursor reports no usage, so UsageReported stays false.
func ParseCursor(stdout []byte, stderr string, runErr error, r Request) (Result, error) {
	res := Result{Model: r.Model}
	var c struct {
		IsError bool   `json:"is_error"`
		Subtype string `json:"subtype"`
		Result  string `json:"result"`
	}
	if err := json.Unmarshal([]byte(outerObject(strings.TrimSpace(string(stdout)))), &c); err != nil {
		if runErr != nil {
			return res, failure("cursor-agent", runErr, stderr, stdout)
		}
		return res, fmt.Errorf("cursor-agent's answer is not JSON: %s", clip(string(stdout), 200))
	}
	if c.IsError {
		return res, fmt.Errorf("cursor-agent: %s", clip(strings.TrimSpace(c.Subtype+" "+c.Result), 300))
	}
	if runErr != nil {
		return res, failure("cursor-agent", runErr, stderr, nil)
	}
	res.Text = strings.TrimSpace(c.Result)
	return fromText("cursor-agent", r, res)
}

func call[T any](f func() T) T {
	var zero T
	if f == nil {
		return zero
	}
	return f()
}
