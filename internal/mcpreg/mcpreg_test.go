package mcpreg

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const exe = "/opt/homebrew/bin/caprock"

// fixture is a Registrar over a temp HOME where the named agents are
// "installed" (Find answers a path) and nothing touches the real home.
func fixture(t *testing.T, installed ...string) (*Registrar, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("CODEX_HOME", "")
	have := map[string]bool{}
	for _, a := range installed {
		have[a] = true
	}
	return &Registrar{
		Exe:       func() string { return exe },
		Env:       os.Environ,
		CachedEnv: func() []string { return nil },
		Find: func(name string) string {
			if have[name] {
				return filepath.Join(home, "bin", name)
			}
			return ""
		},
		Home: func() (string, error) { return home, nil },
	}, home
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func states(g *Registrar) map[string]string {
	out := map[string]string{}
	for _, s := range g.Statuses() {
		out[s.Agent] = s.State
	}
	return out
}

func TestStatusNotInstalledAndNotConnected(t *testing.T) {
	g, _ := fixture(t, Claude)
	got := states(g)
	if got[Claude] != NotConnected || got[Codex] != NotInstalled {
		t.Fatalf("states = %v", got)
	}
}

func TestStatusReadsClaudeUserScope(t *testing.T) {
	g, home := fixture(t, Claude)
	cfg := filepath.Join(home, ".claude.json")
	// A project-scoped caprock is not the user scope Connect writes.
	write(t, cfg, `{"numStartups": 3, "projects": {"/x": {"mcpServers": {"caprock": {"command": "caprock", "args": ["mcp"]}}}}}`)
	if s := g.Status(Claude); s.State != NotConnected || s.Config != cfg {
		t.Fatalf("project scope only: %+v", s)
	}
	write(t, cfg, `{"mcpServers": {"caprock": {"type": "stdio", "command": "`+exe+`", "args": ["mcp"], "env": {}}}}`)
	if s := g.Status(Claude); s.State != Connected || s.Command != exe+" mcp" {
		t.Fatalf("user scope: %+v", s)
	}
	write(t, cfg, `{"mcpServers": {"caprock": {"command": "/old/place/caprock", "args": ["mcp"]}}}`)
	if s := g.Status(Claude); s.State != Different || s.Command != "/old/place/caprock mcp" {
		t.Fatalf("stale path: %+v", s)
	}
	write(t, cfg, `{"mcpServers": {"caprock": {"command": "caprock", "args": ["mcp"]}}}`)
	if s := g.Status(Claude); s.State != Connected {
		t.Fatalf("the copy-and-paste command counts as connected: %+v", s)
	}
	write(t, cfg, `{not json`)
	if s := g.Status(Claude); s.State != NotConnected {
		t.Fatalf("broken file: %+v", s)
	}
}

func TestStatusHonoursConfigDirOverrides(t *testing.T) {
	g, home := fixture(t, Claude, Codex)
	alt := filepath.Join(home, "alt")
	g.CachedEnv = func() []string { return []string{"CLAUDE_CONFIG_DIR=" + alt, "CODEX_HOME=" + alt} }
	write(t, filepath.Join(alt, ".claude.json"), `{"mcpServers": {"caprock": {"command": "`+exe+`", "args": ["mcp"]}}}`)
	write(t, filepath.Join(alt, "config.toml"), "[mcp_servers.caprock]\ncommand = \""+exe+"\"\nargs = [\"mcp\"]\n")
	if got := states(g); got[Claude] != Connected || got[Codex] != Connected {
		t.Fatalf("states = %v", got)
	}
}

func TestStatusReadsCodexConfig(t *testing.T) {
	g, home := fixture(t, Codex)
	cfg := filepath.Join(home, ".codex", "config.toml")
	for _, c := range []struct {
		body, want, cmd string
	}{
		{"model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"x\"\n", NotConnected, ""},
		{"[mcp_servers.caprock]\ncommand = \"" + exe + "\"\nargs = [\"mcp\"]\n", Connected, exe + " mcp"},
		{"[mcp_servers.\"caprock\"]\r\ncommand = '" + exe + "'\r\nargs = [ 'mcp' ]\r\n\r\n[mcp_servers.caprock.env]\r\nX = \"1\"\r\n", Connected, exe + " mcp"},
		{"[mcp_servers.caprock]\ncommand = \"/gone/caprock\"\nargs = [\"mcp\"]\n", Different, "/gone/caprock mcp"},
		{"[mcp_servers.caprock]\ncommand = \"" + exe + "\"\nargs = [\"serve\"]\n", Different, exe + " serve"},
		{"[mcp_servers.caprock]\n# command = \"" + exe + "\"\n[profiles.x]\ncommand = \"" + exe + "\"\nargs = [\"mcp\"]\n", Different, ""},
	} {
		write(t, cfg, c.body)
		s := g.Status(Codex)
		if s.State != c.want || s.Command != c.cmd {
			t.Errorf("%q: %+v, want %s %q", c.body, s, c.want, c.cmd)
		}
	}
}

func TestTomlStrings(t *testing.T) {
	got := tomlStrings(`["mcp", 'b', "c\"d"] # trailing`)
	if strings.Join(got, "|") != `mcp|b|c"d` {
		t.Fatalf("got %q", got)
	}
	if s, _, _ := tomlString(`"C:\\Program Files\\caprock.exe"`); s != `C:\Program Files\caprock.exe` {
		t.Fatalf("escaped path: %q", s)
	}
}

func TestStable(t *testing.T) {
	for p, want := range map[string]bool{
		"/opt/homebrew/bin/caprock":                                                          true,
		"/Users/a/Library/Application Support/caprock/bin/caprock":                           true,
		"/private/var/folders/x/T/AppTranslocation/ABC/d/Caprock.app/Contents/MacOS/caprock": false,
		"/Volumes/Caprock/Caprock.app/Contents/MacOS/caprock":                                false,
		"/var/folders/x/T/go-build123/b001/exe/caprock":                                      false,
	} {
		if Stable(p) != want {
			t.Errorf("Stable(%s) = %v", p, !want)
		}
	}
}

// fakeCLI puts a fake `claude` and `codex` on PATH in a temp dir: each
// appends its argv to <dir>/<name>.argv, and `mcp add` / `mcp remove` write or
// clear the registration in the config under home, as the real CLIs would.
// Never the real binaries, never the real home.
func fakeCLI(t *testing.T, home string) (string, *Registrar) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLIs are shell scripts")
	}
	dir := t.TempDir()
	script := `#!/bin/sh
echo "$@" >> "` + dir + `/$(basename "$0").argv"
if [ -n "$FAKE_FAIL" ]; then echo "Error: $FAKE_FAIL" >&2; exit 1; fi
case "$(basename "$0") $1 $2" in
  "claude mcp add") printf '{"mcpServers":{"caprock":{"command":"%s","args":["mcp"]}}}' "$7" > "$HOME/.claude.json" ;;
  "claude mcp remove") printf '{"mcpServers":{}}' > "$HOME/.claude.json" ;;
  "codex mcp add") mkdir -p "$HOME/.codex"; printf '[mcp_servers.caprock]\ncommand = "%s"\nargs = ["mcp"]\n' "$5" > "$HOME/.codex/config.toml" ;;
  "codex mcp remove") printf '' > "$HOME/.codex/config.toml" ;;
esac
`
	for _, name := range []string{"claude", "codex"} {
		write(t, filepath.Join(dir, name), script)
		if err := os.Chmod(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+"/usr/bin:/bin")
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("CODEX_HOME", "")
	g := &Registrar{
		Exe:       func() string { return exe },
		Env:       func() []string { return append(os.Environ(), "HOME="+home) },
		CachedEnv: func() []string { return nil },
		Find: func(name string) string {
			p, _ := exec.LookPath(name)
			return p
		},
		Home: func() (string, error) { return home, nil },
	}
	return dir, g
}

func argv(t *testing.T, dir, name string) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name+".argv"))
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

func TestConnectAndDisconnectRunTheAgentsCLI(t *testing.T) {
	home := t.TempDir()
	dir, g := fakeCLI(t, home)
	ctx := context.Background()

	st, err := g.Connect(ctx, Claude)
	if err != nil || st.State != Connected {
		t.Fatalf("connect claude: %+v %v", st, err)
	}
	st, err = g.Connect(ctx, Codex)
	if err != nil || st.State != Connected {
		t.Fatalf("connect codex: %+v %v", st, err)
	}
	// Connected already: nothing runs.
	if _, err := g.Connect(ctx, Claude); err != nil {
		t.Fatal(err)
	}
	if st, err = g.Disconnect(ctx, Claude); err != nil || st.State != NotConnected {
		t.Fatalf("disconnect claude: %+v %v", st, err)
	}
	if st, err = g.Disconnect(ctx, Codex); err != nil || st.State != NotConnected {
		t.Fatalf("disconnect codex: %+v %v", st, err)
	}
	// Not connected: nothing runs.
	if _, err := g.Disconnect(ctx, Codex); err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(argv(t, dir, "claude"), "\n"), "mcp add -s user caprock -- "+exe+" mcp\nmcp remove -s user caprock"; got != want {
		t.Errorf("claude argv:\n%s\nwant:\n%s", got, want)
	}
	if got, want := strings.Join(argv(t, dir, "codex"), "\n"), "mcp add caprock -- "+exe+" mcp\nmcp remove caprock"; got != want {
		t.Errorf("codex argv:\n%s\nwant:\n%s", got, want)
	}
}

func TestConnectReplacesAStalePath(t *testing.T) {
	home := t.TempDir()
	dir, g := fakeCLI(t, home)
	write(t, filepath.Join(home, ".claude.json"), `{"mcpServers":{"caprock":{"command":"/old/caprock","args":["mcp"]}}}`)
	st, err := g.Connect(context.Background(), Claude)
	if err != nil || st.State != Connected {
		t.Fatalf("%+v %v", st, err)
	}
	if got := argv(t, dir, "claude"); len(got) != 2 || got[0] != "mcp remove -s user caprock" || !strings.HasPrefix(got[1], "mcp add -s user caprock -- ") {
		t.Fatalf("argv = %q", got)
	}
}

func TestConnectShowsTheCLIsError(t *testing.T) {
	home := t.TempDir()
	_, g := fakeCLI(t, home)
	g.Env = func() []string { return append(os.Environ(), "HOME="+home, "FAKE_FAIL=not logged in") }
	st, err := g.Connect(context.Background(), Codex)
	var cli *CLIError
	if !errors.As(err, &cli) || !strings.Contains(err.Error(), "Error: not logged in") || !strings.HasPrefix(err.Error(), "Codex: ") {
		t.Fatalf("err = %v", err)
	}
	if st.State != NotConnected {
		t.Fatalf("state after a failure: %+v", st)
	}
}

func TestConnectRefusesWhatCannotBeDone(t *testing.T) {
	g, _ := fixture(t, Claude)
	if _, err := g.Connect(context.Background(), Codex); !errors.Is(err, ErrNotInstalled) {
		t.Errorf("not installed: %v", err)
	}
	if _, err := g.Connect(context.Background(), "gemini"); !errors.Is(err, ErrUnknownAgent) {
		t.Errorf("unknown: %v", err)
	}
	g.Exe = func() string {
		return "/private/var/folders/x/T/AppTranslocation/A/d/Caprock.app/Contents/MacOS/caprock"
	}
	if _, err := g.Connect(context.Background(), Claude); !errors.Is(err, ErrNoStablePath) {
		t.Errorf("translocated: %v", err)
	}
}
