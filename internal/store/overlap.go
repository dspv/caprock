package store

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/dspv/caprock/internal/tcc"
)

// Same-checkout overlap — two live sessions working in one folder.
//
// The owner ran two Claude Code sessions in ~/dev/caprock on master, both
// working with subagents, and the Live pulse showed two identical rows
// (2026-10-14, translated: "agents' work is duplicated … a decision is
// needed"). Caprock does not block it — two agents in one checkout is
// sometimes exactly what someone wants — but it shows it, and shows the part
// that is a real risk: a file both have edited in the last half hour, where
// one agent's change can be written over by the other's.
//
// A checkout is the folder the nearest `.git` entry sits in: a clone's root,
// or a linked worktree's own folder. Unlike RepoFromCwd, a linked worktree is
// NOT folded into its main repository here — two sessions in two worktrees of
// one repository edit different files on disk and are exactly the arrangement
// this exists to suggest.

// OverlapWindowMs is how far back "edited by both" looks: half an hour.
const OverlapWindowMs = 30 * 60 * 1000

// checkoutCache memoises CheckoutOf: a session's folder is read once.
var checkoutCache sync.Map // normalized cwd -> checkout

// CheckoutOf is the folder of the git checkout holding cwd (its nearest
// `.git` entry, a directory or a linked worktree's file), normalized; a folder
// in no repository is its own checkout. "" for an empty cwd.
func CheckoutOf(cwd string) string {
	n := normalizeCwd(cwd)
	if n == "" {
		return ""
	}
	if v, ok := checkoutCache.Load(n); ok {
		return v.(string)
	}
	top := findCheckout(n)
	if top == "" {
		top = n
	}
	checkoutCache.Store(n, top)
	return top
}

// findCheckout walks up from dir to the first folder holding `.git`; "" when
// there is none, or dir is somewhere a read would ask the user (tcc).
func findCheckout(dir string) string {
	if tcc.GuardedBeyondWork(dir) {
		return ""
	}
	d := filepath.FromSlash(dir)
	for i := 0; i < maxWalkUp; i++ {
		if _, err := os.Stat(filepath.Join(d, ".git")); err == nil {
			return normalizeCwd(d)
		}
		next := filepath.Dir(d)
		if next == d {
			return ""
		}
		d = next
	}
	return ""
}

// OverlapPeer is another live session in the same checkout, and the files
// both have edited in the window (empty when they share only the folder).
type OverlapPeer struct {
	SessionID string   `json:"session_id"`
	StartedAt int64    `json:"started_at"`
	Files     []string `json:"files"`
}

// SessionOverlap is one session's neighbours in its checkout.
type SessionOverlap struct {
	Checkout string        `json:"checkout"`
	With     []OverlapPeer `json:"with"`
}

// Overlaps groups the live sessions by checkout and, for every group of two
// or more, reads which files each edited since sinceMs: one query on
// session_files (Edit, Write, MultiEdit and NotebookEdit paths, kept by the
// rollup with their last edit), only for the sessions in a shared checkout.
// A session alone in its checkout is absent from the answer, so the usual
// case — nobody shares — asks the database nothing beyond the session list.
func Overlaps(ctx context.Context, q Querier, live []Session, sinceMs int64) (map[string]SessionOverlap, error) {
	groups := map[string][]Session{}
	for _, s := range live {
		if s.Status == "ended" {
			continue
		}
		c := CheckoutOf(s.Cwd)
		if c == "" {
			continue
		}
		groups[c] = append(groups[c], s)
	}
	var ids []any
	for c, g := range groups {
		if len(g) < 2 {
			delete(groups, c)
			continue
		}
		for _, s := range g {
			ids = append(ids, s.SessionID)
		}
	}
	out := map[string]SessionOverlap{}
	if len(ids) == 0 {
		return out, nil
	}
	edited := map[string]map[string]bool{}
	rows, err := q.QueryContext(ctx, `SELECT session_id, path FROM session_files
		WHERE session_id IN (?`+strings.Repeat(",?", len(ids)-1)+`) AND last_ts >= ?`, append(ids, sinceMs)...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id, p string
		if err := rows.Scan(&id, &p); err != nil {
			return nil, err
		}
		if p = normalizeCwd(p); p == "" {
			continue
		}
		if edited[id] == nil {
			edited[id] = map[string]bool{}
		}
		edited[id][p] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for c, g := range groups {
		sort.Slice(g, func(i, j int) bool {
			if g[i].StartedAt != g[j].StartedAt {
				return g[i].StartedAt < g[j].StartedAt
			}
			return g[i].SessionID < g[j].SessionID
		})
		for _, s := range g {
			o := SessionOverlap{Checkout: c}
			for _, p := range g {
				if p.SessionID == s.SessionID {
					continue
				}
				files := []string{}
				for f := range edited[s.SessionID] {
					if edited[p.SessionID][f] {
						files = append(files, f)
					}
				}
				sort.Strings(files)
				o.With = append(o.With, OverlapPeer{SessionID: p.SessionID, StartedAt: p.StartedAt, Files: files})
			}
			out[s.SessionID] = o
		}
	}
	return out, nil
}
