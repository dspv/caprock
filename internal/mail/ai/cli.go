package ai

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

// CLI asks the user's own logged-in coding CLI, headless, with no tool it
// can use, from an empty folder of Caprock's. The login is the CLI's: Caprock
// never sees a token. Every flag below was read from the real `--help` of
// Claude Code 2.1.300, codex-cli 0.161.0 and Gemini CLI 0.62.0 on
// 2026-10-15; the comments on Argv say what each one is for.
//
// The prompt always goes on stdin, never on the command line: a long thread
// is not cut by a command-line limit, and a Windows .cmd shim (npm installs
// codex and gemini as one) cannot carry it there intact.
type CLI struct {
	Provider string // ProviderClaude, ProviderCodex or ProviderGemini
	Binary   string // the CLI's absolute path
	Env      []string
	Dir      string // an empty working folder of Caprock's
	Model    string // "" is the CLI's default
	Timeout  time.Duration
}

// claudeSettings turns every hook off — the user's, Caprock's shim among
// them — so a summary is not recorded as a session (same file as Second
// Brain's, internal/brain/runner.go).
const claudeSettings = `{"disableAllHooks": true}` + "\n"

// geminiSettings is given to Gemini CLI as its system settings file, which
// overrides the user's: no hooks, no built-in tool (an empty `tools.core`
// allowlist registers none) and no skills.
const geminiSettings = `{"hooksConfig": {"enabled": false}, "tools": {"core": []}, "skills": {"enabled": false}}` + "\n"

// geminiPrompt is the -p text. Gemini CLI appends it to stdin, where the
// real prompt is; it holds nothing a batch shim would mangle.
const geminiPrompt = "Answer as instructed above."

// codexDisabled are the Codex features turned off for a call: every tool
// that runs a command, reads a file, browses or reaches another agent.
// `code_mode_host` off makes Code Mode fail closed, which is what a call
// that tries to run a command now gets (seen on 2026-10-15: "code-mode host
// is disabled", and the model answered without it).
var codexDisabled = []string{
	"shell_tool", "unified_exec", "code_mode", "code_mode_host", "hooks", "plugins", "apps",
	"multi_agent", "multi_agent_v2", "image_generation", "view_image", "browser_use",
	"computer_use", "skill_search", "tool_suggest", "goals", "memories",
}

// Argv is the command line and the stdin for one call. files are the paths
// the call uses inside Dir: the Claude settings file, the Codex answer file.
//
// claude: `-p --output-format json` prints one JSON result; `--tools ""`
// gives the model no tool at all; `--no-session-persistence` writes no
// transcript, so Caprock's own ingest never sees the call; `--setting-sources
// local` from an empty folder and `--settings` holding `disableAllHooks` keep
// the user's hooks, plugins and memory files out. `--system-prompt` carries
// the instructions, except through a Windows .cmd shim, where they go to
// stdin with the rest (as Second Brain does).
//
// codex: `exec` is the non-interactive mode, the prompt read from stdin
// (`-`); `--ephemeral` writes no session file; `--ignore-user-config` and
// `--ignore-rules` leave the user's config.toml (MCP servers, hooks,
// profiles) and execpolicy rules out — the login is still read from
// CODEX_HOME; `--sandbox read-only` and the features above leave nothing
// that can act; `-c web_search="disabled"` turns the web search tool off;
// `--skip-git-repo-check` because Caprock's folder is no repository; `-o`
// writes the final answer to a file.
//
// gemini: `-p` is the non-interactive mode, appended to stdin; `-o json`
// prints one JSON object with `response`; `--approval-mode plan` is its
// read-only mode; `--skip-trust` trusts Caprock's empty folder for the
// call; `-e none` loads no extension and `--allowed-mcp-server-names` with
// a name no server has loads no MCP server; the system settings file
// (GEMINI_CLI_SYSTEM_SETTINGS_PATH, see Chat) removes hooks and tools.
func Argv(provider, model, system, user string, batch bool, files map[string]string) ([]string, string, error) {
	switch provider {
	case ProviderClaude:
		args := []string{"-p", "--output-format", "json", "--tools", "", "--no-session-persistence",
			"--setting-sources", "local", "--settings", files["settings"]}
		if model != "" {
			args = append(args, "--model", model)
		}
		if batch {
			return args, system + "\n\n" + user, nil
		}
		return append(args, "--system-prompt", system), user, nil
	case ProviderCodex:
		args := []string{"exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
			"--sandbox", "read-only", "--color", "never", "-c", "web_search=disabled"}
		for _, f := range codexDisabled {
			args = append(args, "--disable", f)
		}
		if model != "" {
			args = append(args, "-m", model)
		}
		args = append(args, "-o", files["out"], "-")
		return args, system + "\n\n" + user, nil
	case ProviderGemini:
		args := []string{"-p", geminiPrompt, "-o", "json", "--approval-mode", "plan", "--skip-trust",
			"-e", "none", "--allowed-mcp-server-names", "caprock-none"}
		if model != "" {
			args = append(args, "-m", model)
		}
		return args, system + "\n\n" + user, nil
	}
	return nil, "", fmt.Errorf("unknown CLI provider %q", provider)
}

// IsBatch reports whether a binary is a Windows .cmd or .bat shim.
func IsBatch(p string) bool {
	ext := strings.ToLower(filepath.Ext(p))
	return ext == ".cmd" || ext == ".bat"
}

// Chat makes one call.
func (c *CLI) Chat(ctx context.Context, system, user string) (string, error) {
	p, _ := Lookup(c.Provider)
	name := p.Command
	if c.Binary == "" {
		return "", fmt.Errorf("%s was not found on this computer", name)
	}
	if err := os.MkdirAll(c.Dir, 0o700); err != nil {
		return "", err
	}
	files := map[string]string{}
	env := c.Env
	switch c.Provider {
	case ProviderClaude:
		files["settings"] = filepath.Join(c.Dir, "claude-settings.json")
		if err := os.WriteFile(files["settings"], []byte(claudeSettings), 0o600); err != nil {
			return "", err
		}
	case ProviderCodex:
		f, err := os.CreateTemp(c.Dir, "codex-answer-*.txt")
		if err != nil {
			return "", err
		}
		_ = f.Close()
		files["out"] = f.Name()
		defer os.Remove(f.Name())
	case ProviderGemini:
		path := filepath.Join(c.Dir, "gemini-settings.json")
		if err := os.WriteFile(path, []byte(geminiSettings), 0o600); err != nil {
			return "", err
		}
		if env == nil {
			env = os.Environ()
		}
		env = append(append([]string(nil), env...), "GEMINI_CLI_SYSTEM_SETTINGS_PATH="+path)
	}
	args, stdin, err := Argv(c.Provider, c.Model, system, user, IsBatch(c.Binary), files)
	if err != nil {
		return "", err
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 3 * time.Minute
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := hidewin.CommandContext(cctx, c.Binary, args...)
	cmd.Dir = c.Dir
	if len(env) > 0 {
		cmd.Env = env
	}
	cmd.Stdin = strings.NewReader(stdin)
	// A node CLI's children can hold the pipes after it is killed; do not
	// wait on them forever.
	cmd.WaitDelay = 5 * time.Second
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	runErr := cmd.Run()
	if cctx.Err() != nil && ctx.Err() == nil {
		return "", fmt.Errorf("%s did not answer within %s", name, timeout)
	}
	switch c.Provider {
	case ProviderClaude:
		return parseClaude(out.Bytes(), errb.String(), runErr)
	case ProviderGemini:
		return parseGemini(out.Bytes(), errb.String(), runErr)
	default:
		return parseCodex(files["out"], errb.String(), runErr)
	}
}

func cliFailure(name string, runErr error, stderr string) error {
	msg := lastLine(stderr)
	if msg == "" {
		msg = runErr.Error()
	}
	return fmt.Errorf("%s: %s", name, clip(msg, 300))
}

// parseClaude reads `claude -p --output-format json`.
func parseClaude(stdout []byte, stderr string, runErr error) (string, error) {
	var r struct {
		IsError bool   `json:"is_error"`
		Subtype string `json:"subtype"`
		Result  string `json:"result"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(stdout), &r); err != nil {
		if runErr != nil {
			return "", cliFailure("claude", runErr, stderr)
		}
		return "", fmt.Errorf("claude's answer is not JSON: %s", clip(string(stdout), 200))
	}
	if r.IsError {
		return "", fmt.Errorf("claude: %s", clip(strings.TrimSpace(r.Subtype+" "+r.Result), 300))
	}
	if strings.TrimSpace(r.Result) == "" {
		return "", errors.New("claude returned nothing")
	}
	return stripThinking(r.Result), nil
}

// parseGemini reads `gemini -o json`: `response`, or `error.message` (also
// on a failed run, where it is printed to stdout or stderr).
func parseGemini(stdout []byte, stderr string, runErr error) (string, error) {
	var r struct {
		Response string `json:"response"`
		Error    *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	text := bytes.TrimSpace(stdout)
	if len(text) == 0 {
		text = []byte(firstObject(stderr))
	}
	if err := json.Unmarshal([]byte(firstObject(string(text))), &r); err != nil {
		if runErr != nil {
			return "", cliFailure("gemini", runErr, stderr)
		}
		return "", fmt.Errorf("gemini's answer is not JSON: %s", clip(string(stdout), 200))
	}
	if r.Error != nil && r.Error.Message != "" {
		return "", fmt.Errorf("gemini: %s", clip(strings.TrimSpace(r.Error.Message), 300))
	}
	if runErr != nil {
		return "", cliFailure("gemini", runErr, stderr)
	}
	if strings.TrimSpace(r.Response) == "" {
		return "", errors.New("gemini returned nothing")
	}
	return stripThinking(r.Response), nil
}

// parseCodex reads the answer `codex exec -o` wrote.
func parseCodex(path, stderr string, runErr error) (string, error) {
	if runErr != nil {
		return "", cliFailure("codex", runErr, stderr)
	}
	b, err := os.ReadFile(path)
	if err != nil || strings.TrimSpace(string(b)) == "" {
		if msg := lastLine(stderr); msg != "" {
			return "", fmt.Errorf("codex returned nothing: %s", clip(msg, 300))
		}
		return "", errors.New("codex returned nothing")
	}
	return stripThinking(string(b)), nil
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

// firstObject returns the first {...} span of s (from the first '{' to the
// last '}'), or s itself.
func firstObject(s string) string {
	i, j := strings.IndexByte(s, '{'), strings.LastIndexByte(s, '}')
	if i < 0 || j < i {
		return s
	}
	return s[i : j+1]
}
