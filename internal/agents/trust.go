package agents

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/hooks"
)

// userHomeDir is indirected so tests can inject a home on every OS (os.UserHomeDir
// reads %USERPROFILE% on Windows, not $HOME, so t.Setenv("HOME", …) alone would
// not redirect it).
var userHomeDir = os.UserHomeDir

// dataDir is indirected for the same reason: tests must never write a real grant
// ledger into the user's data directory. testTrustDataDir gives every test in
// this package a temp dir automatically (see trustTestHome), so a new test that
// forgets to isolate cannot reach the real one.
var dataDir = config.DataDir

// grantsFile is the name, inside Caprock's own data dir, of the record of which
// folders Caprock granted trust to. It lives here rather than in ~/.claude.json
// because it is Caprock's bookkeeping, not Claude Code's.
const grantsFile = "trust-grants.json"

// trustFolder pre-accepts Claude Code's folder-trust dialog for dir, so a session
// Caprock spawns into a fresh directory (the repo, or a worker's worktree) starts
// straight in its main loop instead of blocking on the interactive
// "Is this a project you trust?" screen — which --dangerously-skip-permissions
// does NOT suppress. It sets projects[dir].hasTrustDialogAccepted=true in
// ~/.claude.json, the same field Claude Code writes when a human clicks "Yes".
//
// The file belongs to the user and is large (hundreds of projects), so it is
// read and written through the ordered-JSON codec in internal/hooks: a plain
// map[string]any round-trip sorted every key alphabetically and truncated any
// integer beyond 2^53 through float64. Key order in another product's file is
// not ours to assume is insignificant.
//
// Every grant is recorded in Caprock's own data dir so `caprock hooks uninstall`
// can revoke exactly what Caprock added and nothing the user accepted
// themselves. See RevokeTrustGrants.
//
// It is best-effort: any error (missing home, unparsable/large config, write
// failure) is returned for logging but must never fail a spawn.
func trustFolder(dir string) error {
	home, err := userHomeDir()
	if err != nil {
		return err
	}
	path := filepath.Join(home, ".claude.json")

	root, err := readOrderedConfig(path)
	if err != nil {
		return err
	}

	projects, _ := root.Get("projects")
	pobj, ok := projects.(*hooks.Object)
	if !ok || pobj == nil {
		pobj = hooks.NewObject()
		root.Set("projects", pobj)
	}
	entry, _ := pobj.Get(dir)
	eobj, ok := entry.(*hooks.Object)
	if !ok || eobj == nil {
		eobj = hooks.NewObject()
		pobj.Set(dir, eobj)
	}
	if trusted, _ := eobj.Values["hasTrustDialogAccepted"].(bool); trusted {
		// Already trusted — by the user or by an earlier spawn. Leave the file
		// untouched, and do not claim the grant as ours: revoking it later would
		// undo a decision the user may have made themselves.
		return nil
	}
	eobj.Set("hasTrustDialogAccepted", true)

	b, err := hooks.MarshalIndent(root)
	if err != nil {
		return err
	}
	if err := config.WriteFileAtomic(path, b, 0o600); err != nil {
		return err
	}
	// Record the grant only after the write succeeded, so the ledger never claims
	// a grant that was not made. A failure to record is not fatal to the spawn:
	// the worst case is a grant we cannot revoke automatically, which is the
	// behaviour that shipped before this ledger existed.
	return recordTrustGrant(dir)
}

// readOrderedConfig reads ~/.claude.json preserving key order. A missing or
// empty file yields a fresh object; an unparsable one is an error, so a config
// we cannot understand is never overwritten.
func readOrderedConfig(path string) (*hooks.Object, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return hooks.NewObject(), nil
	}
	if err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return hooks.NewObject(), nil
	}
	v, err := hooks.ParseOrdered(b)
	if err != nil {
		return nil, err // do not overwrite a config we cannot parse
	}
	obj, ok := v.(*hooks.Object)
	if !ok {
		return nil, errors.New("agents: ~/.claude.json is not a JSON object")
	}
	return obj, nil
}

// grantsPath returns the path of the trust-grant ledger in Caprock's data dir.
func grantsPath() (string, error) {
	dir, err := dataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, grantsFile), nil
}

// readTrustGrants loads the set of folders Caprock has granted trust to. A
// missing or corrupt ledger reads as empty: it is a convenience record, and
// losing it must never break a spawn or an uninstall.
func readTrustGrants() map[string]bool {
	out := map[string]bool{}
	path, err := grantsPath()
	if err != nil {
		return out
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var paths []string
	if err := json.Unmarshal(b, &paths); err != nil {
		return out
	}
	for _, p := range paths {
		out[p] = true
	}
	return out
}

// recordTrustGrant adds dir to the ledger of folders Caprock granted trust to.
func recordTrustGrant(dir string) error {
	grants := readTrustGrants()
	if grants[dir] {
		return nil
	}
	grants[dir] = true
	paths := make([]string, 0, len(grants))
	for p := range grants {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	b, err := json.MarshalIndent(paths, "", "  ")
	if err != nil {
		return err
	}
	path, err := grantsPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return config.WriteFileAtomic(path, append(b, '\n'), 0o600)
}

// RevokeTrustGrants removes hasTrustDialogAccepted from every folder Caprock
// granted it to, and clears the ledger. Grants Caprock did not create are left
// alone — the user may have accepted those folders themselves, and undoing a
// human's decision is not uninstall's job. Returns how many were revoked.
//
// It exists because the grant was previously permanent and one-way: nothing,
// including `caprock hooks uninstall`, ever removed it, so a machine
// accumulated a trusted-project entry per worktree forever — including for
// worktrees long since deleted.
func RevokeTrustGrants() (int, error) {
	grants := readTrustGrants()
	if len(grants) == 0 {
		return 0, nil
	}
	home, err := userHomeDir()
	if err != nil {
		return 0, err
	}
	path := filepath.Join(home, ".claude.json")
	root, err := readOrderedConfig(path)
	if err != nil {
		return 0, err
	}
	projects, _ := root.Get("projects")
	pobj, ok := projects.(*hooks.Object)
	revoked := 0
	if ok && pobj != nil {
		for dir := range grants {
			entry, _ := pobj.Get(dir)
			eobj, ok := entry.(*hooks.Object)
			if !ok || eobj == nil {
				continue
			}
			if _, present := eobj.Get("hasTrustDialogAccepted"); !present {
				continue
			}
			eobj.Delete("hasTrustDialogAccepted")
			// An entry that held nothing but our grant is ours to remove entirely;
			// one carrying the user's own settings stays.
			if eobj.Len() == 0 {
				pobj.Delete(dir)
			}
			revoked++
		}
		if revoked > 0 {
			b, err := hooks.MarshalIndent(root)
			if err != nil {
				return 0, err
			}
			if err := config.WriteFileAtomic(path, b, 0o600); err != nil {
				return 0, err
			}
		}
	}
	// Clear the ledger either way: the grants are gone, or the entries were
	// already absent, and a stale ledger would only mislead a later uninstall.
	if p, err := grantsPath(); err == nil {
		_ = os.Remove(p)
	}
	return revoked, nil
}

// TrustGrantCount reports how many folders Caprock has granted trust to, for
// the uninstall command's summary line.
func TrustGrantCount() int { return len(readTrustGrants()) }
