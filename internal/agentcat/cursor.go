package agentcat

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/cursor"
)

// Cursor's CLI takes a model id with --model, from the list the account is
// offered — which only `cursor-agent models` knows, over the network, so the
// catalog does not run it (rule 4). What it offers instead is what this
// machine's Cursor already says: the model cli-config.json names, the models
// its recent CLI chats last ran on, and the three ids the CLI's own --help
// gives as examples (2025.09.12, read 2026-11-16). Any other id is typed.
var cursorHelpModels = []string{"gpt-5", "sonnet-4", "sonnet-4-thinking"}

func cursorConfigDir(env Env) string {
	if v := env.get("CURSOR_CONFIG_DIR"); v != "" {
		return v
	}
	if v := env.get("XDG_CONFIG_HOME"); v != "" {
		return filepath.Join(v, "cursor")
	}
	return filepath.Join(env.Home, ".cursor")
}

func cursorEntry(env Env, ok, win bool) Entry {
	e := Entry{ID: "cursor", Label: "Cursor", Installed: ok, Observed: true, Prompt: true, TypedModel: true, Models: []Model{}}
	if !ok {
		// cursor.com/docs/cli/installation, read 2026-11-16.
		cmd := "curl https://cursor.com/install -fsS | bash"
		if win {
			cmd = "irm 'https://cursor.com/install?win32=true' | iex"
		}
		e.Setup = notInstalled("Cursor's CLI", cmd, "https://cursor.com/docs/cli/installation")
		return e
	}
	e.Ready = true
	dir := cursorConfigDir(env)
	seen := map[string]bool{}
	add := func(id, label string) {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		e.Models = append(e.Models, Model{ID: id, Label: label})
	}
	if m := cursor.CLIConfiguredModel(dir); m != "" {
		e.Default = m
		add(m, m+" · your default")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	for _, c := range cursor.CLIChats(ctx, dir, 20) {
		add(c.Model, c.Model+" · used recently")
	}
	for _, m := range cursorHelpModels {
		add(m, m)
	}
	return e
}
