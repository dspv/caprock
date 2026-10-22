// Package mcpreg tells whether `caprock mcp` is registered with the user's
// coding agents, and registers or removes it when the user clicks Connect or
// Disconnect (ADR-078).
//
// Nothing here ever runs on its own. Status is a read of the agent's own
// config file; Connect and Disconnect run the agent's own CLI — `claude mcp
// add -s user …`, `codex mcp add …` — so the agent writes its config the way
// it always does, and a format change on its side cannot be corrupted by a
// writer on ours.
//
// Why the status reads the file instead of asking `claude mcp get caprock`:
// that command starts Node (about a second) and then health-checks the server
// by starting it, so every look at the Second Brain screen would launch a
// `caprock mcp` child under Claude Code. The user-scope servers are a
// documented top-level key of `~/.claude.json` (`mcpServers`), and Codex's are
// a documented table of `~/.codex/config.toml` (`[mcp_servers.<name>]`). Both
// reads are tolerant: a file that cannot be read or parsed reads as "not
// connected", never as an error on screen.
package mcpreg

import (
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

// The agents Caprock can register itself with.
const (
	Claude = "claude"
	Codex  = "codex"
)

// Agents is the order the screens list them in.
var Agents = []string{Claude, Codex}

// Name is the name the screens use for each agent.
var Name = map[string]string{Claude: "Claude Code", Codex: "Codex"}

// ServerName is the name Caprock registers under.
const ServerName = "caprock"

// The states of one agent's registration.
const (
	NotInstalled = "not_installed" // the agent's CLI is not on this machine
	NotConnected = "not_connected" // installed; no caprock server registered
	Connected    = "connected"     // registered, starting this caprock
	Different    = "different"     // registered, but starting another command (a stale path)
)

// Status is one agent's registration as the screens show it.
type Status struct {
	Agent string `json:"agent"`
	Name  string `json:"name"`
	State string `json:"state"`
	// Command is the command line the agent's config starts, when caprock is
	// registered: what "Update path" replaces.
	Command string `json:"command,omitempty"`
	// Config is the file the status was read from.
	Config string `json:"config,omitempty"`
}

// ErrUnknownAgent is a Connect or Disconnect for an agent not in Agents.
var ErrUnknownAgent = errors.New("unknown agent: want claude or codex")

// ErrNotInstalled is a Connect for an agent whose CLI is not on this machine.
var ErrNotInstalled = errors.New("not installed on this machine")

// ErrNoStablePath is a Connect from a binary whose path will not last: a
// macOS translocated app, a disk image, or a `go run` build.
var ErrNoStablePath = errors.New("this caprock runs from a temporary location; install it (or move the app to Applications) and try again")

// CLIError is a failed run of the agent's CLI, carrying what it printed.
type CLIError struct {
	Agent  string
	Output string
	Err    error
}

func (e *CLIError) Error() string {
	msg := strings.TrimSpace(e.Output)
	if msg == "" {
		msg = e.Err.Error()
	}
	return fmt.Sprintf("%s: %s", Name[e.Agent], msg)
}

func (e *CLIError) Unwrap() error { return e.Err }

// Registrar reads and changes the registrations. Fill every func field.
type Registrar struct {
	// Exe is the caprock binary to register, in the form that survives an
	// upgrade.
	Exe func() string
	// Env is the environment the agents' CLIs run with: the user's login
	// shell's (internal/userenv), since the daemon's own PATH under launchd
	// has neither claude nor node.
	Env func() []string
	// CachedEnv is the same environment if already resolved, for the status
	// read, which must never wait for a shell profile. May return nil.
	CachedEnv func() []string
	// Find resolves an agent's CLI to an absolute path, "" when absent.
	Find func(name string) string
	// Home is the user's home directory.
	Home func() (string, error)
	// Timeout bounds one CLI run; 0 is a minute.
	Timeout time.Duration

	mu    sync.Mutex // one change at a time
	cache sync.Map   // config path -> cachedRead
}

type cachedRead struct {
	mod  time.Time
	size int64
	srv  *server
}

// server is one registered caprock entry: the command and its arguments.
type server struct {
	command string
	args    []string
}

// Executable is the path Connect registers, with an error when it would not
// last.
func (g *Registrar) Executable() (string, error) {
	exe := g.Exe()
	if exe == "" {
		return "", errors.New("cannot tell where this caprock runs from")
	}
	if !Stable(exe) {
		return exe, ErrNoStablePath
	}
	return exe, nil
}

// Stable reports whether exe is a path worth writing into an agent's config:
// not a macOS App Translocation mount, an app on a disk image, or a `go run`
// build, each of which is gone by the next reboot or sooner. The desktop app's
// daemon runs from its own copy in the data directory (ADR-040), which is.
func Stable(exe string) bool {
	p := filepath.ToSlash(exe)
	switch {
	case strings.Contains(p, "/AppTranslocation/"),
		strings.HasPrefix(p, "/Volumes/") && strings.Contains(p, ".app/"),
		strings.Contains(p, "/go-build"):
		return false
	}
	return true
}

// Statuses reports every agent's registration.
func (g *Registrar) Statuses() []Status {
	out := make([]Status, 0, len(Agents))
	for _, a := range Agents {
		out = append(out, g.Status(a))
	}
	return out
}

// Status reports one agent's registration.
func (g *Registrar) Status(agent string) Status {
	st := Status{Agent: agent, Name: Name[agent]}
	if g.Find(agent) == "" {
		st.State = NotInstalled
		return st
	}
	path := g.configPath(agent)
	st.Config = path
	srv := g.read(agent, path)
	if srv == nil {
		st.State = NotConnected
		return st
	}
	st.Command = strings.TrimSpace(strings.Join(append([]string{srv.command}, srv.args...), " "))
	if g.matches(srv) {
		st.State = Connected
	} else {
		st.State = Different
	}
	return st
}

// matches reports whether a registered server starts this caprock's MCP
// server. A bare `caprock` (the copy-and-paste command from Settings) counts:
// it starts whatever caprock is on the agent's PATH, which is the user's call.
// So does an absolute path that resolves to this same binary through a link.
func (g *Registrar) matches(s *server) bool {
	if len(s.args) != 1 || s.args[0] != "mcp" || s.command == "" {
		return false
	}
	cmd, exe := s.command, g.Exe()
	if cmd == exe {
		return true
	}
	if !strings.ContainsAny(cmd, `/\`) {
		return strings.TrimSuffix(strings.ToLower(cmd), ".exe") == "caprock"
	}
	if exe == "" {
		return false
	}
	a, errA := filepath.EvalSymlinks(cmd)
	b, errB := filepath.EvalSymlinks(exe)
	return errA == nil && errB == nil && a == b
}

// configPath is where the agent keeps its user-scope MCP servers, honouring
// the override each agent documents (CLAUDE_CONFIG_DIR, CODEX_HOME) as the
// user's shell sets it, since that is the environment Connect runs the CLI in.
func (g *Registrar) configPath(agent string) string {
	home, _ := g.Home()
	env := g.CachedEnv()
	switch agent {
	case Claude:
		if d := envValue(env, "CLAUDE_CONFIG_DIR"); d != "" {
			return filepath.Join(d, ".claude.json")
		}
		return filepath.Join(home, ".claude.json")
	case Codex:
		if d := envValue(env, "CODEX_HOME"); d != "" {
			return filepath.Join(d, "config.toml")
		}
		return filepath.Join(home, ".codex", "config.toml")
	}
	return ""
}

// envValue is key's value in env, falling back to the daemon's own.
func envValue(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		if k, v, ok := strings.Cut(env[i], "="); ok && k == key {
			return strings.TrimSpace(v)
		}
	}
	return strings.TrimSpace(os.Getenv(key))
}

// read returns the caprock entry in the agent's config at path, or nil. The
// parse is cached on the file's size and modification time: ~/.claude.json
// grows to megabytes, and this runs every time the Second Brain screen opens.
func (g *Registrar) read(agent, path string) *server {
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() {
		return nil
	}
	if c, ok := g.cache.Load(path); ok {
		if c := c.(cachedRead); c.mod.Equal(fi.ModTime()) && c.size == fi.Size() {
			return c.srv
		}
	}
	b, err := os.ReadFile(path) //nolint:gosec // the agent's own config, at the path it documents
	if err != nil {
		return nil
	}
	var srv *server
	if agent == Claude {
		srv = parseClaude(b)
	} else {
		srv = parseCodex(b)
	}
	g.cache.Store(path, cachedRead{mod: fi.ModTime(), size: fi.Size(), srv: srv})
	return srv
}

// parseClaude finds mcpServers.caprock at the top level of .claude.json: the
// user scope. Project-scoped entries (under "projects") are not read: Connect
// registers for the user, and that is what the status is about.
func parseClaude(b []byte) *server {
	var cfg struct {
		MCPServers map[string]struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if json.Unmarshal(b, &cfg) != nil {
		return nil
	}
	s, ok := cfg.MCPServers[ServerName]
	if !ok {
		return nil
	}
	return &server{command: s.Command, args: s.Args}
}

// parseCodex finds the [mcp_servers.caprock] table in Codex's config.toml and
// its command and args. A full TOML parser would be a new dependency for two
// keys; this reads the shape `codex mcp add` writes and the one Settings tells
// people to paste: a table header, then `command = "…"` and `args = [ … ]` on
// one line each. A table it cannot read still counts as registered: its
// command reads as "", so the screen offers "Update path".
func parseCodex(b []byte) *server {
	var srv *server
	in := false
	text := strings.ReplaceAll(string(b), "\r\n", "\n")
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			in = isCaprockTable(line)
			if in && srv == nil {
				srv = &server{}
			}
			continue
		}
		if !in {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch strings.Trim(strings.TrimSpace(key), `"'`) {
		case "command":
			if s, _, ok := tomlString(strings.TrimSpace(val)); ok {
				srv.command = s
			}
		case "args":
			srv.args = tomlStrings(strings.TrimSpace(val))
		}
	}
	return srv
}

// isCaprockTable reports whether a header line opens [mcp_servers.caprock]
// (quoted or not, with or without spaces), not a sub-table such as
// [mcp_servers.caprock.env].
func isCaprockTable(line string) bool {
	if strings.HasPrefix(line, "[[") {
		return false
	}
	end := strings.Index(line, "]")
	if end < 0 {
		return false
	}
	parts := strings.Split(line[1:end], ".")
	if len(parts) != 2 {
		return false
	}
	for i := range parts {
		parts[i] = strings.Trim(strings.TrimSpace(parts[i]), `"'`)
	}
	return parts[0] == "mcp_servers" && parts[1] == ServerName
}

// tomlString reads one basic ("…", with escapes) or literal ('…') string at
// the start of v, and returns it with the rest of v after its closing quote.
func tomlString(v string) (string, string, bool) {
	if v == "" {
		return "", "", false
	}
	switch v[0] {
	case '\'':
		end := strings.IndexByte(v[1:], '\'')
		if end < 0 {
			return "", "", false
		}
		return v[1 : 1+end], v[2+end:], true
	case '"':
		var sb strings.Builder
		for i := 1; i < len(v); i++ {
			c := v[i]
			switch {
			case c == '"':
				return sb.String(), v[i+1:], true
			case c == '\\' && i+1 < len(v):
				i++
				switch v[i] {
				case 'n':
					sb.WriteByte('\n')
				case 't':
					sb.WriteByte('\t')
				default:
					sb.WriteByte(v[i]) // \\ and \" and anything else, as written
				}
			default:
				sb.WriteByte(c)
			}
		}
	}
	return "", "", false
}

// tomlStrings reads a one-line array of strings: ["mcp"] or ['mcp', "x"].
func tomlStrings(v string) []string {
	if !strings.HasPrefix(v, "[") {
		return nil
	}
	v = strings.TrimSpace(v[1:])
	var out []string
	for v != "" && v[0] != ']' {
		s, rest, ok := tomlString(v)
		if !ok {
			return out
		}
		out = append(out, s)
		v = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(rest), ","))
	}
	return out
}

// Connect registers this caprock with the agent, for the user (every
// project). Already connected is a no-op; a registration that starts another
// command is removed first, then added again with this one.
func (g *Registrar) Connect(ctx context.Context, agent string) (Status, error) {
	if _, ok := Name[agent]; !ok {
		return Status{}, ErrUnknownAgent
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	st := g.Status(agent)
	switch st.State {
	case NotInstalled:
		return st, fmt.Errorf("%s is %w", Name[agent], ErrNotInstalled)
	case Connected:
		return st, nil
	}
	exe, err := g.Executable()
	if err != nil {
		return st, err
	}
	if st.State == Different {
		if err := g.run(ctx, agent, RemoveArgs(agent)); err != nil {
			return g.Status(agent), err
		}
	}
	if err := g.run(ctx, agent, AddArgs(agent, exe)); err != nil {
		return g.Status(agent), err
	}
	return g.Status(agent), nil
}

// Disconnect removes the caprock registration from the agent's user config.
// Not registered is a no-op.
func (g *Registrar) Disconnect(ctx context.Context, agent string) (Status, error) {
	if _, ok := Name[agent]; !ok {
		return Status{}, ErrUnknownAgent
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	st := g.Status(agent)
	if st.State == NotInstalled || st.State == NotConnected {
		return st, nil
	}
	if err := g.run(ctx, agent, RemoveArgs(agent)); err != nil {
		return g.Status(agent), err
	}
	return g.Status(agent), nil
}

// AddArgs is the argv after the agent's CLI that registers exe.
func AddArgs(agent, exe string) []string {
	if agent == Claude {
		return []string{"mcp", "add", "-s", "user", ServerName, "--", exe, "mcp"}
	}
	return []string{"mcp", "add", ServerName, "--", exe, "mcp"}
}

// RemoveArgs is the argv after the agent's CLI that removes the registration.
func RemoveArgs(agent string) []string {
	if agent == Claude {
		return []string{"mcp", "remove", "-s", "user", ServerName}
	}
	return []string{"mcp", "remove", ServerName}
}

// run starts the agent's CLI with args in the user's environment, from their
// home directory (a user-scope change must not depend on where the daemon was
// started), with no input, and returns what it printed on failure.
func (g *Registrar) run(ctx context.Context, agent string, args []string) error {
	bin := g.Find(agent)
	if bin == "" {
		return fmt.Errorf("%s is %w", Name[agent], ErrNotInstalled)
	}
	timeout := g.Timeout
	if timeout <= 0 {
		timeout = time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := hidewin.CommandContext(ctx, bin, args...)
	cmd.Env = g.Env()
	if home, err := g.Home(); err == nil && home != "" {
		cmd.Dir = home
	}
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			err = fmt.Errorf("did not finish in %s", timeout)
		}
		return &CLIError{Agent: agent, Output: clip(out.String()), Err: err}
	}
	// The CLI rewrote its config; the next read must not be served from the
	// cache even on a file system with a coarse modification time.
	g.cache.Clear()
	return nil
}

// clip keeps the last part of a CLI's output: the error is at the end, and a
// Node stack trace above it is not for the screen.
func clip(s string) string {
	s = strings.TrimSpace(s)
	const most = 600
	if len(s) <= most {
		return s
	}
	return "…" + s[len(s)-most:]
}
