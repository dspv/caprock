// Package brain is Second Brain's automatic extraction (ADR-063): it reads
// the prose of finished sessions and keeps the few memories worth keeping,
// linked to their projects and topics, by asking the user's own installed
// `claude` — headless, through the user's own login, the same place the
// session itself went. Nothing goes to a server of Caprock's.
package brain

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

	"github.com/dspv/caprock/internal/agents"
)

// Memory is one memory as the model returns it.
type Memory struct {
	Kind    string   `json:"kind"`
	Title   string   `json:"title"`
	Summary string   `json:"summary"`
	Topics  []string `json:"topics"`
	// Passage is the number of the passage it came from, 1-based; 0 when the
	// model did not say.
	Passage int `json:"passage,omitempty"`
	// Related and Contradicts are 0-based indexes of other memories in the
	// same answer.
	Related     []int `json:"related,omitempty"`
	Contradicts []int `json:"contradicts,omitempty"`
}

// Request is one extraction call.
type Request struct {
	System string
	Prompt string
	Model  string
}

// Result is what one call returned and what it cost, as claude reported it.
type Result struct {
	Memories  []Memory
	Model     string
	TokensIn  int64 // input, cache read and cache write
	TokensOut int64
	CostUSD   float64
}

// Runner makes the call. ClaudeRunner runs the user's claude; tests use a
// function or the fake claude in testdata.
type Runner interface {
	Run(ctx context.Context, r Request) (Result, error)
}

// RunnerFunc adapts a function to a Runner.
type RunnerFunc func(ctx context.Context, r Request) (Result, error)

// Run calls f.
func (f RunnerFunc) Run(ctx context.Context, r Request) (Result, error) { return f(ctx, r) }

// ErrNoClaude is returned when no claude binary can be found.
var ErrNoClaude = errors.New("claude was not found on this computer")

// ClaudeRunner runs `claude -p` headlessly. The flags, each checked against
// `claude --help` of Claude Code 2.1.299 on 2026-10-14:
//
//   - `-p --output-format json`: one JSON result on stdout, with `usage`,
//     `total_cost_usd`, `result` and, with --json-schema, `structured_output`.
//   - `--tools ""`: no tool at all, so the model can only answer.
//   - `--no-session-persistence`: no transcript is written, so Caprock's own
//     ingest never sees the call as a session.
//   - `--setting-sources local` with the working directory an empty folder
//     of Caprock's, and `--settings` naming a file that holds
//     `{"disableAllHooks": true}`: the user's hooks — Caprock's shim among
//     them — do not fire, and the user's settings, plugins and memory files
//     are not loaded (measured: about 4,300 input tokens a call instead of
//     16,600 with them, 2026-10-14). The login is the user's own: it is read
//     from the keychain or credentials file, not from settings.
//   - `--system-prompt` and `--json-schema`: the instructions and the shape of
//     the answer. A Windows .cmd shim cannot carry JSON on its command line,
//     so there both go into the prompt on stdin and the answer is parsed from
//     the text.
//   - `--model`: the user's choice, Haiku by default.
//
// The prompt goes on stdin, never on the command line, so a long session is
// not cut by a command-line limit.
type ClaudeRunner struct {
	// Binary finds claude; "" when it is not installed.
	Binary func() string
	// Env is the environment it runs in (the user's login shell's).
	Env func() []string
	// Dir is an empty working folder of Caprock's.
	Dir string
	// Timeout bounds one call.
	Timeout time.Duration
}

// Run makes one call.
func (c ClaudeRunner) Run(ctx context.Context, r Request) (Result, error) {
	bin := ""
	if c.Binary != nil {
		bin = c.Binary()
	}
	if bin == "" {
		return Result{}, ErrNoClaude
	}
	if err := os.MkdirAll(c.Dir, 0o700); err != nil {
		return Result{}, err
	}
	settings := filepath.Join(c.Dir, "settings.json")
	if err := os.WriteFile(settings, []byte(`{"disableAllHooks": true}`+"\n"), 0o600); err != nil {
		return Result{}, err
	}
	args, stdin := Argv(r, settings, agents.IsBatch(bin))
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 3 * time.Minute
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := hidewin.CommandContext(cctx, bin, args...)
	cmd.Dir = c.Dir
	if c.Env != nil {
		if env := c.Env(); len(env) > 0 {
			cmd.Env = env
		}
	}
	cmd.Stdin = strings.NewReader(stdin)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = strings.TrimSpace(firstLine(out.String()))
		}
		if cctx.Err() != nil {
			return Result{}, fmt.Errorf("claude did not answer within %s", timeout)
		}
		return Result{}, fmt.Errorf("claude: %w: %s", err, clip(msg, 300))
	}
	return ParseResult(out.Bytes())
}

// Argv is the command line and the stdin for a request. With batch (a
// Windows .cmd shim) nothing that holds JSON or quotes goes on the command
// line: the instructions and the schema go into stdin instead.
func Argv(r Request, settingsPath string, batch bool) ([]string, string) {
	args := []string{"-p", "--output-format", "json", "--tools", "", "--no-session-persistence",
		"--setting-sources", "local", "--settings", settingsPath}
	if r.Model != "" {
		args = append(args, "--model", r.Model)
	}
	if batch {
		return args, r.System + "\n\nAnswer with only this JSON, nothing around it: " + Schema + "\n\n" + r.Prompt
	}
	args = append(args, "--system-prompt", r.System, "--json-schema", Schema)
	return args, r.Prompt
}

// claudeJSON is the part of `claude -p --output-format json` read here.
type claudeJSON struct {
	IsError          bool            `json:"is_error"`
	Subtype          string          `json:"subtype"`
	Result           string          `json:"result"`
	StructuredOutput json.RawMessage `json:"structured_output"`
	TotalCostUSD     float64         `json:"total_cost_usd"`
	Usage            struct {
		InputTokens              int64 `json:"input_tokens"`
		OutputTokens             int64 `json:"output_tokens"`
		CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
		CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	} `json:"usage"`
	ModelUsage map[string]json.RawMessage `json:"modelUsage"`
}

// ParseResult reads claude's JSON result: the memories (from the structured
// output, else from the first JSON object in the text), the tokens and the
// cost it reported.
func ParseResult(b []byte) (Result, error) {
	var c claudeJSON
	if err := json.Unmarshal(bytes.TrimSpace(b), &c); err != nil {
		return Result{}, fmt.Errorf("claude's answer is not JSON: %s", clip(string(b), 200))
	}
	res := Result{
		TokensIn:  c.Usage.InputTokens + c.Usage.CacheReadInputTokens + c.Usage.CacheCreationInputTokens,
		TokensOut: c.Usage.OutputTokens,
		CostUSD:   c.TotalCostUSD,
	}
	for m := range c.ModelUsage {
		res.Model = m
		break
	}
	if c.IsError {
		return res, fmt.Errorf("claude: %s %s", c.Subtype, clip(c.Result, 300))
	}
	raw := c.StructuredOutput
	if len(raw) == 0 || string(raw) == "null" {
		raw = json.RawMessage(firstObject(c.Result))
	}
	var body struct {
		Memories []Memory `json:"memories"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return res, fmt.Errorf("claude did not answer in the expected shape: %s", clip(c.Result, 200))
	}
	res.Memories = body.Memories
	return res, nil
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

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
