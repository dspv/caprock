// Package branches lists a repository's branches with what git knows of each
// for the session deck's Branches view (owner, 2026-10-12, translated:
// "seeing branches with statistics would also be interesting"): how far each
// is ahead of and behind the default branch, its last commit's time and
// author. Everything here is local git — `for-each-ref`, no network — read
// only while the view is shown, and kept a few seconds so a burst of reads
// runs git once.
package branches

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/hidewin"

	"github.com/dspv/caprock/internal/tcc"
)

// StaleAfter is how long without a commit makes a branch stale, when it also
// has no open pull request.
const StaleAfter = 30 * 24 * time.Hour

// fallbackMax bounds the branches whose ahead and behind are counted one
// `rev-list` each on a git too old for %(ahead-behind:) (before 2.41); the
// rest are left uncounted rather than slowing the read.
const fallbackMax = 40

// kept is how long one repository's answer is reused.
const kept = 10 * time.Second

// Branch is one branch: local, on origin, or both, under its short name.
type Branch struct {
	Name    string `json:"name"`
	Current bool   `json:"current,omitempty"`
	Default bool   `json:"default,omitempty"`
	Local   bool   `json:"local"`
	// Remote is true when origin has it.
	Remote bool `json:"remote"`
	// Ahead and Behind count commits against the default branch (origin's
	// copy when there is one); nil when not counted.
	Ahead       *int   `json:"ahead,omitempty"`
	Behind      *int   `json:"behind,omitempty"`
	CommittedMS int64  `json:"committed_ms"`
	Author      string `json:"author,omitempty"`
	SHA         string `json:"sha,omitempty"`
	// Subject is its last commit's subject line (the release plan's row
	// title for a pushed branch with no pull request).
	Subject string `json:"subject,omitempty"`
}

// Listing is a repository's branches and what they were compared with.
type Listing struct {
	// Default is the default branch's name; Base the ref counted against
	// ("origin/main", else "main"); both empty when neither is known.
	Default  string   `json:"default,omitempty"`
	Base     string   `json:"base,omitempty"`
	Current  string   `json:"current,omitempty"`
	Branches []Branch `json:"branches"`
}

// ref is one line of for-each-ref.
type ref struct {
	name   string // short branch name
	remote bool
	sha    string
	ts     int64
	author string
	// subject is the last commit's subject line.
	subject string
	ahead   *int
	behind  *int
}

// refFormat is what is asked of for-each-ref; the ahead-behind field only
// when the base exists and git can count it.
func refFormat(base string) string {
	f := "%(refname)%09%(objectname)%09%(committerdate:unix)%09%(authorname)"
	if base != "" {
		f += "%09%(ahead-behind:" + base + ")"
	}
	// The subject last, after a NUL: a subject may hold a tab.
	return f + "%00%(contents:subject)"
}

// parseRefs reads for-each-ref's lines in refFormat: local branches, and
// origin's (its HEAD left out).
func parseRefs(out string) []ref {
	var refs []ref
	for _, line := range strings.Split(strings.TrimRight(out, "\r\n"), "\n") {
		line, subject, _ := strings.Cut(strings.TrimRight(line, "\r"), "\x00")
		f := strings.Split(line, "\t")
		if len(f) < 4 {
			continue
		}
		var r ref
		switch {
		case strings.HasPrefix(f[0], "refs/heads/"):
			r.name = strings.TrimPrefix(f[0], "refs/heads/")
		case strings.HasPrefix(f[0], "refs/remotes/origin/"):
			r.name, r.remote = strings.TrimPrefix(f[0], "refs/remotes/origin/"), true
			if r.name == "HEAD" {
				continue
			}
		default:
			continue
		}
		if r.name == "" {
			continue
		}
		r.sha = f[1]
		ts, _ := strconv.ParseInt(f[2], 10, 64)
		r.ts = ts * 1000
		r.author = f[3]
		r.subject = strings.TrimSpace(subject)
		if len(f) > 4 {
			r.ahead, r.behind = ParseAheadBehind(f[4])
		}
		refs = append(refs, r)
	}
	return refs
}

// ParseAheadBehind reads "A B" — commits ahead of and behind the base, as
// %(ahead-behind:) and `rev-list --left-right --count base...ref` (behind
// first there, see countOne) print it; nil, nil when it is not two counts.
func ParseAheadBehind(s string) (*int, *int) {
	f := strings.Fields(s)
	if len(f) != 2 {
		return nil, nil
	}
	a, err1 := strconv.Atoi(f[0])
	b, err2 := strconv.Atoi(f[1])
	if err1 != nil || err2 != nil || a < 0 || b < 0 {
		return nil, nil
	}
	return &a, &b
}

// merge folds the local and origin refs of one name into a Branch: the local
// one's commit, author and counts when there is a local branch.
func merge(refs []ref) []Branch {
	by := map[string]*Branch{}
	order := []string{}
	for _, r := range refs {
		b := by[r.name]
		if b == nil {
			b = &Branch{Name: r.name}
			by[r.name] = b
			order = append(order, r.name)
		}
		if r.remote {
			b.Remote = true
			if b.Local {
				continue
			}
		} else {
			b.Local = true
		}
		b.SHA, b.CommittedMS, b.Author, b.Ahead, b.Behind, b.Subject = r.sha, r.ts, r.author, r.ahead, r.behind, r.subject
	}
	out := make([]Branch, 0, len(order))
	for _, n := range order {
		out = append(out, *by[n])
	}
	return out
}

type entry struct {
	l  Listing
	at time.Time
}

var cache = struct {
	mu sync.Mutex
	m  map[string]entry
}{m: map[string]entry{}}

// List reads dir's branches: local ones and origin's, compared with the
// default branch (def, else origin's HEAD, else main or master). Kept for a
// few seconds per directory.
func List(ctx context.Context, dir, def string) (Listing, error) {
	key := dir + "\x00" + def
	cache.mu.Lock()
	if e, ok := cache.m[key]; ok && time.Since(e.at) < kept {
		cache.mu.Unlock()
		return e.l, nil
	}
	cache.mu.Unlock()
	l, err := list(ctx, dir, def)
	if err != nil {
		return Listing{}, err
	}
	cache.mu.Lock()
	if len(cache.m) >= 64 {
		cache.m = map[string]entry{}
	}
	cache.m[key] = entry{l: l, at: time.Now()}
	cache.mu.Unlock()
	return l, nil
}

func list(ctx context.Context, dir, def string) (Listing, error) {
	var l Listing
	if cur, err := git(ctx, dir, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil {
		l.Current = strings.TrimSpace(cur)
	}
	if def == "" {
		if out, err := git(ctx, dir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); err == nil {
			_, def, _ = strings.Cut(strings.TrimSpace(out), "/")
		}
	}
	if def == "" {
		for _, n := range []string{"main", "master"} {
			if _, err := git(ctx, dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+n); err == nil {
				def = n
				break
			}
		}
	}
	l.Default = def
	if def != "" {
		for _, b := range []string{"refs/remotes/origin/" + def, "refs/heads/" + def} {
			if _, err := git(ctx, dir, "rev-parse", "--verify", "--quiet", b); err == nil {
				l.Base = strings.TrimPrefix(strings.TrimPrefix(b, "refs/remotes/"), "refs/heads/")
				break
			}
		}
	}
	out, err := git(ctx, dir, "for-each-ref", "--format="+refFormat(l.Base), "refs/heads", "refs/remotes/origin")
	counted := l.Base != ""
	if err != nil && l.Base != "" {
		// A git before 2.41 does not know %(ahead-behind:): read without it
		// and count the newest branches one by one.
		out, err = git(ctx, dir, "for-each-ref", "--format="+refFormat(""), "refs/heads", "refs/remotes/origin")
		counted = false
	}
	if err != nil {
		return Listing{}, errors.New("not a git repository")
	}
	l.Branches = merge(parseRefs(out))
	if !counted && l.Base != "" {
		countEach(ctx, dir, l.Base, l.Branches)
	}
	for i := range l.Branches {
		b := &l.Branches[i]
		b.Current = b.Name == l.Current
		b.Default = b.Name == def
	}
	return l, nil
}

// countEach counts ahead and behind with one rev-list per branch, the most
// recently committed first, up to fallbackMax.
func countEach(ctx context.Context, dir, base string, bs []Branch) {
	idx := make([]int, len(bs))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool { return bs[idx[a]].CommittedMS > bs[idx[b]].CommittedMS })
	for n, i := range idx {
		if n >= fallbackMax {
			break
		}
		r := bs[i].SHA
		if r == "" {
			continue
		}
		out, err := git(ctx, dir, "rev-list", "--left-right", "--count", base+"..."+r)
		if err != nil {
			continue
		}
		// --left-right prints the base's side (behind) first.
		behind, ahead := ParseAheadBehind(out)
		bs[i].Ahead, bs[i].Behind = ahead, behind
	}
}

// IsStale is the deck's stale mark: no commit in StaleAfter and no open pull
// request. The default branch is never stale; a branch with no known commit
// time is not called stale.
func IsStale(b Branch, openPR bool, now time.Time) bool {
	if b.Default || openPR || b.CommittedMS <= 0 {
		return false
	}
	return now.Sub(time.UnixMilli(b.CommittedMS)) > StaleAfter
}

// landed keeps Landed's answers: one pair of commits always gives the same.
var landed = struct {
	mu sync.Mutex
	m  map[string]bool
}{m: map[string]bool{}}

// Landed says whether the commit sha's changes are already on base by
// content: merging it into base changes nothing (`git merge-tree
// --write-tree`, git 2.38+, gives base's own tree). It finds a branch whose
// work reached the default branch by a squash merge or inside another
// branch's batch, which `git cherry` cannot (the patch ids differ). An error
// (an older git, a conflict, an unknown commit) is "not known", never
// "landed". Kept per pair of commits.
func Landed(ctx context.Context, dir, base, sha string) (bool, error) {
	baseSHA, err := git(ctx, dir, "rev-parse", "--verify", "--quiet", base+"^{commit}")
	if err != nil {
		return false, err
	}
	baseSHA = strings.TrimSpace(baseSHA)
	key := dir + "\x00" + baseSHA + "\x00" + sha
	landed.mu.Lock()
	v, ok := landed.m[key]
	landed.mu.Unlock()
	if ok {
		return v, nil
	}
	out, err := git(ctx, dir, "merge-tree", "--write-tree", baseSHA, sha)
	if err != nil {
		return false, err
	}
	tree, _, _ := strings.Cut(strings.TrimSpace(out), "\n")
	own, err := git(ctx, dir, "rev-parse", baseSHA+"^{tree}")
	if err != nil {
		return false, err
	}
	v = strings.TrimSpace(tree) == strings.TrimSpace(own)
	landed.mu.Lock()
	if len(landed.m) >= 4096 {
		landed.m = map[string]bool{}
	}
	landed.m[key] = v
	landed.mu.Unlock()
	return v, nil
}

func git(ctx context.Context, dir string, args ...string) (string, error) {
	if err := tcc.Check(dir); err != nil {
		return "", err
	}
	cmd := hidewin.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", errors.New(strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}
