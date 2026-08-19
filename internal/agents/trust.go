package agents

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/dspv/caprock/internal/config"
)

// trustFolder pre-accepts Claude Code's folder-trust dialog for dir, so a session
// Caprock spawns into a fresh directory (the repo, or a worker's worktree) starts
// straight in its main loop instead of blocking on the interactive
// "Is this a project you trust?" screen — which --dangerously-skip-permissions
// does NOT suppress. It sets projects[dir].hasTrustDialogAccepted=true in
// ~/.claude.json, the same field Claude Code writes when a human clicks "Yes".
//
// It is best-effort: any error (missing home, unparsable/large config, write
// failure) is returned for logging but must never fail a spawn. The config is
// read as a generic map and written back whole, so unrelated keys are preserved
// (key order in ~/.claude.json is not significant).
func trustFolder(dir string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	path := filepath.Join(home, ".claude.json")
	root := map[string]any{}
	if b, err := os.ReadFile(path); err == nil && len(b) > 0 {
		if err := json.Unmarshal(b, &root); err != nil {
			return err // do not overwrite a config we cannot parse
		}
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}

	projects, _ := root["projects"].(map[string]any)
	if projects == nil {
		projects = map[string]any{}
		root["projects"] = projects
	}
	entry, _ := projects[dir].(map[string]any)
	if entry == nil {
		entry = map[string]any{}
		projects[dir] = entry
	}
	if trusted, _ := entry["hasTrustDialogAccepted"].(bool); trusted {
		return nil // already trusted; leave the file untouched
	}
	entry["hasTrustDialogAccepted"] = true

	b, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(path, append(b, '\n'), 0o600)
}
