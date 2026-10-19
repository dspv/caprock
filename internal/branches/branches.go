// Package branches lists a repository's branches with what git knows of each
// for the session deck's Branches view (owner, 2026-10-12, translated:
// "seeing branches with statistics would also be interesting"): how far each
// is ahead of and behind the default branch, its last commit's time and
// author. Everything here is local git — `for-each-ref`, no network — read
// only while the view is shown, and kept a few seconds so a burst of reads
// runs git once.
package branches

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
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

// landedMaxFiles and landedMaxSteps bound the file-by-file check: a branch
// changing more files than landedMaxFiles is not checked that way, and each
// file is looked for in at most landedMaxSteps of base's commits.
const (
	landedMaxFiles = 80
	landedMaxSteps = 20
)

// Landed says whether the commit sha's changes are already on base by
// content. Three checks, cheapest first, any one enough:
//
//   - every commit base lacks has a patch-equivalent on base (`git cherry`):
//     a rebase or a cherry-pick;
//   - merging it into base changes nothing (`git merge-tree --write-tree`,
//     git 2.38+, gives base's own tree): a plain squash merge;
//   - file by file, the branch's own diff (merge-base..sha) is already in
//     that file — on base's tip, or in one of base's commits since the
//     merge-base that touched it: every hunk's new side (its context and
//     added lines, in order) stands in the file, as `git apply -R --check`
//     would want; an added file was there, a deleted one gone. This finds a
//     branch shipped inside a batch PR whose files base has edited since, or
//     whose changelog fragment a release has consumed.
//
// An error (an older git, an unknown commit) is "not known", never
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
	v, err = landedBy(ctx, dir, baseSHA, sha)
	if err != nil {
		return false, err
	}
	landed.mu.Lock()
	if len(landed.m) >= 4096 {
		landed.m = map[string]bool{}
	}
	landed.m[key] = v
	landed.mu.Unlock()
	return v, nil
}

func landedBy(ctx context.Context, dir, baseSHA, sha string) (bool, error) {
	if out, err := git(ctx, dir, "cherry", baseSHA, sha); err == nil && !strings.Contains("\n"+out, "\n+") {
		return true, nil
	}
	if out, err := git(ctx, dir, "merge-tree", "--write-tree", baseSHA, sha); err == nil {
		tree, _, _ := strings.Cut(strings.TrimSpace(out), "\n")
		if own, err := git(ctx, dir, "rev-parse", baseSHA+"^{tree}"); err == nil && strings.TrimSpace(tree) == strings.TrimSpace(own) {
			return true, nil
		}
	}
	if ok, err := landedBySubjects(ctx, dir, baseSHA, sha); err == nil && ok {
		return true, nil
	}
	return landedByFiles(ctx, dir, baseSHA, sha)
}

// minSubject is the shortest commit subject landedBySubjects goes by: a
// "fix" or "wip" names too many commits to say which.
const minSubject = 16

// landedBySubjects is Landed's squash-message check: every commit the branch
// has that base lacks (merges aside) is named, by its subject line, in the
// message of a commit on base since the merge-base — the line itself, its
// "* subject" in a squashed batch's list, or the subject with the pull
// request's " (#N)". A batch squash whose later fixes reworked the branch's
// lines still names them.
func landedBySubjects(ctx context.Context, dir, baseSHA, sha string) (bool, error) {
	out, err := git(ctx, dir, "log", "--no-merges", "--format=%s", baseSHA+".."+sha)
	if err != nil {
		return false, err
	}
	var want []string
	for _, s := range strings.Split(out, "\n") {
		if s = strings.TrimSpace(s); s != "" {
			if len(s) < minSubject {
				return false, nil
			}
			want = append(want, s)
		}
	}
	if len(want) == 0 {
		return false, nil
	}
	mb, err := git(ctx, dir, "merge-base", baseSHA, sha)
	if err != nil {
		return false, err
	}
	out, err = git(ctx, dir, "log", "--format=%B", baseSHA, "^"+strings.TrimSpace(mb))
	if err != nil {
		return false, err
	}
	named := map[string]bool{}
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimPrefix(strings.TrimSpace(l), "* ")
		named[l] = true
		if i := strings.LastIndex(l, " (#"); i > 0 && strings.HasSuffix(l, ")") {
			named[l[:i]] = true
		}
	}
	for _, s := range want {
		if !named[s] {
			return false, nil
		}
	}
	return true, nil
}

// filePatch is one file of a branch's diff.
type filePatch struct {
	path    string
	deleted bool
	// blob is the file's blob on the branch (--full-index), for a change
	// with no hunks to read (binary, mode only, an empty file).
	blob string
	// hunks hold each hunk's new side: its context and added lines.
	hunks [][]string
}

// parsePatch reads `git diff --no-renames --full-index` into files. ok is
// false on anything it cannot place (a quoted path): not known.
func parsePatch(out string) (files []filePatch, ok bool) {
	var cur *filePatch
	var hunk *[]string
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			s := strings.TrimPrefix(line, "diff --git ")
			// "a/P b/P": no renames, so both halves are one path.
			if strings.HasPrefix(s, `"`) || len(s) < 5 || (len(s)-5)%2 != 0 {
				return nil, false
			}
			files = append(files, filePatch{path: s[2 : 2+(len(s)-5)/2]})
			cur, hunk = &files[len(files)-1], nil
		case cur == nil:
		case hunk == nil && strings.HasPrefix(line, "deleted file mode"):
			cur.deleted = true
		case hunk == nil && strings.HasPrefix(line, "index "):
			f := strings.Fields(line)
			if len(f) > 1 {
				if _, nb, ok := strings.Cut(f[1], ".."); ok {
					cur.blob = nb
				}
			}
		case strings.HasPrefix(line, "@@"):
			cur.hunks = append(cur.hunks, nil)
			hunk = &cur.hunks[len(cur.hunks)-1]
		case hunk == nil:
		case strings.HasPrefix(line, " "), strings.HasPrefix(line, "+"):
			*hunk = append(*hunk, line[1:])
		case line == "":
			// A blank context line some tools strip to nothing.
			*hunk = append(*hunk, "")
		}
	}
	return files, true
}

// holds says whether content (a blob's text) has every hunk's new side, in
// order, each as one contiguous run of lines.
func holds(content string, hunks [][]string) bool {
	lines := strings.Split(content, "\n")
	at := 0
	for _, h := range hunks {
		// Trailing blank entries are the diff's final newline, not lines.
		for len(h) > 0 && h[len(h)-1] == "" {
			h = h[:len(h)-1]
		}
		if len(h) == 0 {
			continue
		}
		found := -1
		for i := at; i+len(h) <= len(lines); i++ {
			if lines[i] != h[0] {
				continue
			}
			match := true
			for j := 1; j < len(h); j++ {
				if lines[i+j] != h[j] {
					match = false
					break
				}
			}
			if match {
				found = i
				break
			}
		}
		if found < 0 {
			return false
		}
		at = found + len(h)
	}
	return true
}

// Commits lists the commits sha has that base lacks, the newest limit.
func Commits(ctx context.Context, dir, base, sha string, limit int) ([]string, error) {
	out, err := git(ctx, dir, "rev-list", "--max-count="+strconv.Itoa(limit), sha, "^"+base)
	if err != nil {
		return nil, err
	}
	return strings.Fields(out), nil
}

// landedByFiles is Landed's third check.
func landedByFiles(ctx context.Context, dir, baseSHA, sha string) (bool, error) {
	mb, err := git(ctx, dir, "merge-base", baseSHA, sha)
	if err != nil {
		return false, err
	}
	mb = strings.TrimSpace(mb)
	// A file whose content on base equals the branch's needs nothing more.
	out, err := git(ctx, dir, "diff", "--no-renames", "--name-only", "-z", baseSHA, sha, "--")
	if err != nil {
		return false, err
	}
	differs := map[string]bool{}
	for _, f := range strings.Split(out, "\x00") {
		if f != "" {
			differs[f] = true
		}
	}
	if len(differs) == 0 {
		return true, nil
	}
	out, err = git(ctx, dir, "-c", "core.quotePath=false", "diff", "--no-renames", "--no-ext-diff", "--no-color", "--full-index", mb, sha, "--")
	if err != nil {
		return false, err
	}
	all, ok := parsePatch(out)
	if !ok {
		return false, nil
	}
	var todo []filePatch
	for _, f := range all {
		if differs[f.path] {
			todo = append(todo, f)
		}
	}
	if len(todo) == 0 {
		return true, nil
	}
	if len(todo) > landedMaxFiles {
		return false, nil
	}
	// The commits on base since the merge-base that touched each file,
	// newest first.
	args := []string{"-c", "core.quotePath=false", "log", "--no-renames", "--format=%x00%H", "--name-only", baseSHA, "^" + mb, "--"}
	for _, f := range todo {
		args = append(args, f.path)
	}
	out, err = git(ctx, dir, args...)
	if err != nil {
		return false, err
	}
	steps := map[string][]string{}
	for _, rec := range strings.Split(out, "\x00") {
		lines := strings.Split(strings.TrimSpace(rec), "\n")
		if len(lines) < 2 {
			continue
		}
		for _, p := range lines[1:] {
			if p = strings.TrimSpace(p); p != "" && len(steps[p]) < landedMaxSteps {
				steps[p] = append(steps[p], lines[0])
			}
		}
	}
	cat, err := newCatFile(ctx, dir)
	if err != nil {
		return false, err
	}
	defer cat.close()
	for _, f := range todo {
		ok, err := fileLanded(cat, f, append([]string{baseSHA}, steps[f.path]...))
		if err != nil || !ok {
			return false, err
		}
	}
	return true, nil
}

// fileLanded looks for one file's change at each commit, in order.
func fileLanded(cat *catFile, f filePatch, commits []string) (bool, error) {
	seen := map[string]bool{}
	for _, c := range commits {
		blob, body, err := cat.get(c + ":" + f.path)
		if err != nil {
			return false, err
		}
		if seen[blob] {
			continue
		}
		seen[blob] = true
		switch {
		case f.deleted:
			if blob == "" {
				return true, nil
			}
		case blob == "":
		case len(f.hunks) == 0:
			if blob == f.blob {
				return true, nil
			}
		case holds(body, f.hunks):
			return true, nil
		}
	}
	return false, nil
}

// catFile is one `git cat-file --batch`, asked a blob at a time.
type catFile struct {
	cmd *exec.Cmd
	in  io.WriteCloser
	out *bufio.Reader
}

func newCatFile(ctx context.Context, dir string) (*catFile, error) {
	if err := tcc.Check(dir); err != nil {
		return nil, err
	}
	cmd := hidewin.CommandContext(ctx, "git", "-C", dir, "cat-file", "--batch")
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &catFile{cmd: cmd, in: in, out: bufio.NewReader(out)}, nil
}

// get reads "<commit>:<path>": the blob's name and text, or "" when the
// commit has no such file.
func (c *catFile) get(spec string) (string, string, error) {
	if strings.ContainsAny(spec, "\n") {
		return "", "", errors.New("a path with a newline")
	}
	if _, err := io.WriteString(c.in, spec+"\n"); err != nil {
		return "", "", err
	}
	head, err := c.out.ReadString('\n')
	if err != nil {
		return "", "", err
	}
	if strings.HasSuffix(head, " missing\n") || strings.HasSuffix(head, " ambiguous\n") {
		return "", "", nil
	}
	f := strings.Fields(head)
	if len(f) != 3 {
		return "", "", errors.New("cat-file: " + strings.TrimSpace(head))
	}
	n, err := strconv.Atoi(f[2])
	if err != nil {
		return "", "", err
	}
	buf := make([]byte, n+1)
	if _, err := io.ReadFull(c.out, buf); err != nil {
		return "", "", err
	}
	if f[1] != "blob" {
		return "", "", nil
	}
	return f[0], string(buf[:n]), nil
}

func (c *catFile) close() {
	_ = c.in.Close()
	_ = c.cmd.Wait()
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
