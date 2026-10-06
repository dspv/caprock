package projects

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/tcc"
)

// Changes: review a worktree's uncommitted work and commit, push or pull it
// without a terminal (.ai/03-contracts.md § Changes). Every git command runs
// with fixed arguments (no shell), under a timeout, with -C pointing at the
// worktree, `--literal-pathspecs` so a file named `*` or `:(top)` is only that
// file, and with paths a caller sent only after they were found in the
// worktree's own `git status`. Nothing here forces: no `push --force`, no
// `reset --hard`, no `clean`; discarding asks twice.

// Timeouts per kind of git command.
const (
	readTimeout   = 10 * time.Second
	indexTimeout  = 30 * time.Second
	commitTimeout = 3 * time.Minute // hooks run here: linters, tests
	remoteTimeout = 2 * time.Minute
)

// Limits on what is read and returned.
const (
	// MaxChangeFiles is how many files a status lists before it says
	// Truncated; a checkout with an unignored node_modules lists far more.
	MaxChangeFiles = 3000
	// MaxPatchBytes is how much of one file's patch is returned.
	MaxPatchBytes = 1 << 20
	// maxUntrackedDiff is the largest new file diffed at all.
	maxUntrackedDiff = 16 << 20
	// maxCountBytes and maxCountFiles bound counting new files' lines.
	maxCountBytes = 1 << 20
	maxCountFiles = 300
	// maxOutput is how much of a command's output (hooks included) is kept.
	maxOutput = 32 << 10
	// maxMessage is the longest commit message taken.
	maxMessage = 64 << 10
)

// ChangeFile is one file in one area of a worktree.
type ChangeFile struct {
	Path     string `json:"path"`
	OrigPath string `json:"orig_path,omitempty"` // a rename or copy's source
	// Status is added, modified, deleted, renamed, copied, typechange,
	// untracked or conflicted.
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Binary    bool   `json:"binary,omitempty"`
}

// Changes is a worktree's uncommitted work and where its branch stands.
type Changes struct {
	ProjectID int64  `json:"project_id"`
	Worktree  string `json:"worktree"` // "" for the main checkout
	Path      string `json:"path"`
	Branch    string `json:"branch"` // "" when detached
	Detached  bool   `json:"detached,omitempty"`
	Head      string `json:"head,omitempty"` // the commit; "" before the first
	Upstream  string `json:"upstream,omitempty"`
	Ahead     int    `json:"ahead"`
	Behind    int    `json:"behind"`
	// Remote is where a push goes: the upstream's remote, else origin, else
	// the only remote; "" when there is none.
	Remote        string `json:"remote,omitempty"`
	RemoteURL     string `json:"remote_url,omitempty"`
	DefaultBranch string `json:"default_branch,omitempty"`
	// Published is true when the upstream is the branch of the same name on
	// Remote — what a pull request is opened from.
	Published bool `json:"published"`
	// State is merging, rebasing, cherry-picking or reverting while one is
	// under way.
	State      string       `json:"state,omitempty"`
	Staged     []ChangeFile `json:"staged"`
	Unstaged   []ChangeFile `json:"unstaged"`
	Conflicted []ChangeFile `json:"conflicted"`
	Truncated  bool         `json:"truncated,omitempty"`
	// Token changes whenever the status does.
	Token string `json:"token"`
	At    int64  `json:"at"`
}

// FilePatch is one file's diff in one area.
type FilePatch struct {
	Path      string `json:"path"`
	OrigPath  string `json:"orig_path,omitempty"`
	Staged    bool   `json:"staged"`
	Status    string `json:"status"`
	Patch     string `json:"patch"`
	Binary    bool   `json:"binary,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	// TooLarge is a new file not diffed at all.
	TooLarge bool `json:"too_large,omitempty"`
	Bytes    int  `json:"bytes"` // the whole patch, before any cut
	// Token names this exact patch; staging one hunk of it must quote it.
	Token string `json:"token"`
}

// CommitResult is a commit just made.
type CommitResult struct {
	SHA     string `json:"sha"`
	Short   string `json:"short"`
	Subject string `json:"subject"`
	Output  string `json:"output,omitempty"` // hooks and git's own lines
}

// RemoteResult is a push, pull or fetch that worked.
type RemoteResult struct {
	Remote      string `json:"remote,omitempty"`
	Branch      string `json:"branch,omitempty"`
	UpstreamSet bool   `json:"upstream_set,omitempty"` // the push named a new upstream
	Output      string `json:"output,omitempty"`
}

// DiscardPreview is what a discard would remove, and the token that
// confirms it.
type DiscardPreview struct {
	Confirm string       `json:"confirm"`
	Files   []ChangeFile `json:"files"`
}

// Kinds of ChangeError.
const (
	KindInvalid  = "invalid"  // the request names something it may not
	KindState    = "state"    // the worktree is not in a state for it
	KindStale    = "stale"    // it changed since the caller looked
	KindAuth     = "auth"     // the remote refused the credentials
	KindNetwork  = "network"  // the remote could not be reached
	KindRejected = "rejected" // the remote has commits this branch lacks
	KindDiverged = "diverged" // a pull cannot fast-forward
	KindHook     = "hook"     // a hook said no
	KindTimeout  = "timeout"  // git took too long and was stopped
	KindGit      = "git"      // anything else git refused
)

// ChangeError is a refusal or a failed git command, with git's own output.
type ChangeError struct {
	Kind    string
	Message string
	Output  string
	// Preview is set on a stale discard: the fresh list and token.
	Preview *DiscardPreview
}

func (e *ChangeError) Error() string { return e.Message }

func changeErr(kind, format string, a ...any) error {
	return &ChangeError{Kind: kind, Message: fmt.Sprintf(format, a...)}
}

// ErrNoWorktree is an unknown or missing worktree name.
var ErrNoWorktree = errors.New("no such worktree")

// gitRun is one git command's result.
type gitRun struct {
	out    []byte // stdout, or stdout and stderr together when combined
	errOut string // stderr when not combined
}

// gitOpts is how one git command runs.
type gitOpts struct {
	timeout time.Duration
	stdin   []byte
	// combined puts stderr into out, in the order written, as a person at a
	// terminal would read a hook's output.
	combined bool
	// literal reads every path argument as a path, never a pattern: a file
	// named `*` or `:(top)` is only that file. Not for commit and push,
	// whose hooks inherit it.
	literal bool
}

// gitCmd runs git in dir with the environment write commands need: the
// login shell's (hooks find node, a credential helper its keychain), no
// terminal prompts, git's messages in English so they can be classified.
func (s *Service) gitCmd(ctx context.Context, o gitOpts, dir string, args ...string) (gitRun, error) {
	if err := tcc.Check(dir); err != nil {
		return gitRun{}, err
	}
	if err := tcc.Check(dir); err != nil {
		return gitRun{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, o.timeout)
	defer cancel()
	full := []string{"--no-optional-locks"}
	if o.literal {
		full = append(full, "--literal-pathspecs")
	}
	full = append(append(full, "-C", dir), args...)
	cmd := exec.CommandContext(ctx, gitBin, full...) //nolint:gosec // fixed git subcommands; paths come from git status
	env := os.Environ()
	if s.Env != nil {
		env = s.Env()
	}
	cmd.Env = append(withoutLocale(env), "GIT_TERMINAL_PROMPT=0", "LC_MESSAGES=C")
	cmd.WaitDelay = 2 * time.Second
	if o.stdin != nil {
		cmd.Stdin = bytes.NewReader(o.stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	if o.combined {
		cmd.Stderr = &out
	} else {
		cmd.Stderr = &errb
	}
	err := cmd.Run()
	res := gitRun{out: out.Bytes(), errOut: errb.String()}
	if ctx.Err() == context.DeadlineExceeded {
		return res, &ChangeError{Kind: KindTimeout, Message: fmt.Sprintf("git %s did not finish within %s and was stopped", args[0], o.timeout), Output: tail(out.String() + errb.String())}
	}
	if err != nil {
		msg := strings.TrimSpace(errb.String())
		if o.combined || msg == "" {
			msg = strings.TrimSpace(out.String())
		}
		if msg == "" {
			msg = err.Error()
		}
		return res, &ChangeError{Kind: KindGit, Message: lastLines(msg, 6), Output: tail(out.String() + errb.String())}
	}
	return res, nil
}

// read and index are the options of a read and of a change to the index.
var (
	readOpts  = gitOpts{timeout: readTimeout, literal: true}
	indexOpts = gitOpts{timeout: indexTimeout, literal: true}
)

// withoutLocale drops LC_ALL and LANGUAGE, which would override LC_MESSAGES.
func withoutLocale(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if strings.HasPrefix(kv, "LC_ALL=") || strings.HasPrefix(kv, "LANGUAGE=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// tail keeps the last maxOutput bytes of s.
func tail(s string) string {
	if len(s) <= maxOutput {
		return s
	}
	return "…\n" + s[len(s)-maxOutput:]
}

// lastLines keeps the last n lines of s.
func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// WorktreePath is the folder of a project's main checkout (name "") or of
// its linked worktree name.
func (s *Service) WorktreePath(ctx context.Context, id int64, name string) (string, error) {
	p, err := store.GetProject(ctx, s.Store.DB(), id)
	if err != nil {
		return "", err
	}
	if p.Kind != store.ProjectKindRepo {
		return "", changeErr(KindState, "this project is not a git repository")
	}
	root := filepath.FromSlash(p.Root)
	if name == "" {
		return root, nil
	}
	gd, ok := findGitDirs(root)
	if !ok {
		return "", changeErr(KindState, "no git repository at %s", root)
	}
	for _, w := range readWorktrees(gd.common, filepath.Join(root, agents.WorktreeDir)) {
		if w.Name == name && !w.Missing {
			return w.Path, nil
		}
	}
	return "", ErrNoWorktree
}

// lockFor serialises the writes to one worktree, so two clicks never race
// for the index lock.
func (s *Service) lockFor(dir string) func() {
	v, _ := s.changeLocks.LoadOrStore(filepath.Clean(dir), &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// statusEntry is one record of `git status --porcelain=v2 -z`.
type statusEntry struct {
	kind     byte // '1', '2', 'u', '?'
	x, y     byte
	path     string
	origPath string
	line     string // the record as git wrote it
}

type rawStatus struct {
	oid, head, upstream string
	ahead, behind       int
	entries             []statusEntry
	raw                 []byte
}

// readStatus runs and parses `git status --porcelain=v2 -z --branch`.
func (s *Service) readStatus(ctx context.Context, dir string) (rawStatus, error) {
	r, err := s.gitCmd(ctx, readOpts, dir, "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all")
	if err != nil {
		return rawStatus{}, err
	}
	return parseStatusZ(r.out), nil
}

// parseStatusZ reads porcelain v2 records separated by NUL; a rename's
// record is followed by its source path as one more field.
func parseStatusZ(out []byte) rawStatus {
	st := rawStatus{raw: out}
	fields := strings.Split(string(out), "\x00")
	for i := 0; i < len(fields); i++ {
		rec := fields[i]
		if rec == "" {
			continue
		}
		if rest, ok := strings.CutPrefix(rec, "# "); ok {
			key, val, _ := strings.Cut(rest, " ")
			switch key {
			case "branch.oid":
				if val != "(initial)" {
					st.oid = val
				}
			case "branch.head":
				st.head = val
			case "branch.upstream":
				st.upstream = val
			case "branch.ab":
				a, b, _ := strings.Cut(val, " ")
				st.ahead, _ = strconv.Atoi(strings.TrimPrefix(a, "+"))
				st.behind, _ = strconv.Atoi(strings.TrimPrefix(b, "-"))
			}
			continue
		}
		e := statusEntry{kind: rec[0], line: rec}
		switch rec[0] {
		case '1':
			p := strings.SplitN(rec, " ", 9)
			if len(p) < 9 || len(p[1]) != 2 {
				continue
			}
			e.x, e.y, e.path = p[1][0], p[1][1], p[8]
		case '2':
			p := strings.SplitN(rec, " ", 10)
			if len(p) < 10 || len(p[1]) != 2 {
				continue
			}
			e.x, e.y, e.path = p[1][0], p[1][1], p[9]
			if i+1 < len(fields) {
				i++
				e.origPath = fields[i]
				e.line += "\x00" + e.origPath
			}
		case 'u':
			p := strings.SplitN(rec, " ", 11)
			if len(p) < 11 || len(p[1]) != 2 {
				continue
			}
			e.x, e.y, e.path = p[1][0], p[1][1], p[10]
		case '?':
			e.x, e.y, e.path = '?', '?', rec[2:]
		default:
			continue
		}
		st.entries = append(st.entries, e)
	}
	return st
}

// letterStatus names a porcelain status letter.
func letterStatus(c byte) string {
	switch c {
	case 'A':
		return "added"
	case 'D':
		return "deleted"
	case 'R':
		return "renamed"
	case 'C':
		return "copied"
	case 'T':
		return "typechange"
	default:
		return "modified"
	}
}

// numstat is a diff's per-file line counts, keyed by path; -1 means binary.
type numstat map[string][2]int

// readNumstat runs `git diff --numstat -z` with extra args.
func (s *Service) readNumstat(ctx context.Context, dir string, args ...string) numstat {
	r, err := s.gitCmd(ctx, readOpts, dir, append([]string{"diff", "--numstat", "-z", "--no-ext-diff", "--no-color"}, args...)...)
	out := numstat{}
	if err != nil {
		return out
	}
	f := strings.Split(string(r.out), "\x00")
	for i := 0; i < len(f); i++ {
		parts := strings.SplitN(f[i], "\t", 3)
		if len(parts) != 3 {
			continue
		}
		path := parts[2]
		if path == "" && i+2 < len(f) { // a rename: "a\td\t" NUL from NUL to
			path = f[i+2]
			i += 2
		}
		if parts[0] == "-" {
			out[path] = [2]int{-1, -1}
			continue
		}
		a, _ := strconv.Atoi(parts[0])
		d, _ := strconv.Atoi(parts[1])
		out[path] = [2]int{a, d}
	}
	return out
}

func withCounts(f ChangeFile, n numstat) ChangeFile {
	if c, ok := n[f.Path]; ok {
		if c[0] < 0 {
			f.Binary = true
		} else {
			f.Additions, f.Deletions = c[0], c[1]
		}
	}
	return f
}

// Changes reads a worktree's status: what is staged, what is not, what is in
// conflict, and where its branch stands against its upstream.
func (s *Service) Changes(ctx context.Context, id int64, worktree string) (Changes, error) {
	dir, err := s.WorktreePath(ctx, id, worktree)
	if err != nil {
		return Changes{}, err
	}
	return s.changesAt(ctx, id, worktree, dir)
}

func (s *Service) changesAt(ctx context.Context, id int64, worktree, dir string) (Changes, error) {
	st, err := s.readStatus(ctx, dir)
	if err != nil {
		return Changes{}, err
	}
	c := Changes{ProjectID: id, Worktree: worktree, Path: dir, Head: st.oid, Upstream: st.upstream, Ahead: st.ahead, Behind: st.behind,
		Staged: []ChangeFile{}, Unstaged: []ChangeFile{}, Conflicted: []ChangeFile{}, At: s.Now().UnixMilli()}
	if st.head == "(detached)" {
		c.Detached = true
	} else {
		c.Branch = st.head
	}
	sum := sha256.Sum256(st.raw)
	c.Token = hex.EncodeToString(sum[:8])
	staged := s.readNumstat(ctx, dir, "--cached", "-M")
	unstaged := s.readNumstat(ctx, dir)
	counted := 0
	for _, e := range st.entries {
		if len(c.Staged)+len(c.Unstaged)+len(c.Conflicted) >= MaxChangeFiles {
			c.Truncated = true
			break
		}
		switch e.kind {
		case 'u':
			c.Conflicted = append(c.Conflicted, ChangeFile{Path: e.path, Status: "conflicted"})
		case '?':
			f := ChangeFile{Path: e.path, Status: "untracked"}
			if counted < maxCountFiles {
				counted++
				f.Additions, f.Binary = countLines(filepath.Join(dir, filepath.FromSlash(e.path)))
			}
			c.Unstaged = append(c.Unstaged, f)
		default:
			if e.x != '.' {
				f := ChangeFile{Path: e.path, Status: letterStatus(e.x)}
				if e.x == 'R' || e.x == 'C' {
					f.OrigPath = e.origPath
				}
				c.Staged = append(c.Staged, withCounts(f, staged))
			}
			if e.y != '.' {
				c.Unstaged = append(c.Unstaged, withCounts(ChangeFile{Path: e.path, Status: letterStatus(e.y)}, unstaged))
			}
		}
	}
	gd, _ := findGitDirs(dir)
	c.State = repoState(gd.git)
	c.DefaultBranch = readDefaultBranch(gd.common)
	cfg := s.readRemoteConfig(ctx, dir)
	c.Remote, c.RemoteURL, c.Published = cfg.pushTarget(c.Branch)
	return c, nil
}

// countLines counts a new file's lines, and says whether it looks binary.
func countLines(path string) (int, bool) {
	st, err := os.Lstat(path)
	if err != nil || !st.Mode().IsRegular() || st.Size() > maxCountBytes {
		return 0, false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	head := b
	if len(head) > 8000 {
		head = head[:8000]
	}
	if bytes.IndexByte(head, 0) >= 0 {
		return 0, true
	}
	n := bytes.Count(b, []byte("\n"))
	if len(b) > 0 && b[len(b)-1] != '\n' {
		n++
	}
	return n, false
}

// repoState says which multi-step operation git is in the middle of.
func repoState(gitDir string) string {
	if gitDir == "" {
		return ""
	}
	has := func(name string) bool { _, err := os.Stat(filepath.Join(gitDir, name)); return err == nil }
	switch {
	case has("rebase-merge"), has("rebase-apply"):
		return "rebasing"
	case has("MERGE_HEAD"):
		return "merging"
	case has("CHERRY_PICK_HEAD"):
		return "cherry-picking"
	case has("REVERT_HEAD"):
		return "reverting"
	}
	return ""
}

// remoteConfig is the remotes and branch tracking from git config.
type remoteConfig struct {
	urls   map[string]string // remote name -> url
	remote map[string]string // branch -> branch.<b>.remote
	merge  map[string]string // branch -> branch.<b>.merge
}

// readRemoteConfig asks git config (includes and all) for remotes and
// tracking, in one process.
func (s *Service) readRemoteConfig(ctx context.Context, dir string) remoteConfig {
	cfg := remoteConfig{urls: map[string]string{}, remote: map[string]string{}, merge: map[string]string{}}
	r, err := s.gitCmd(ctx, readOpts, dir, "config", "--null", "--get-regexp", `^(remote\..*\.url|branch\..*\.(remote|merge))$`)
	if err != nil {
		return cfg
	}
	for _, rec := range strings.Split(string(r.out), "\x00") {
		key, val, ok := strings.Cut(rec, "\n")
		if !ok {
			continue
		}
		switch {
		case strings.HasPrefix(key, "remote.") && strings.HasSuffix(key, ".url"):
			cfg.urls[strings.TrimSuffix(strings.TrimPrefix(key, "remote."), ".url")] = val
		case strings.HasPrefix(key, "branch.") && strings.HasSuffix(key, ".remote"):
			cfg.remote[strings.TrimSuffix(strings.TrimPrefix(key, "branch."), ".remote")] = val
		case strings.HasPrefix(key, "branch.") && strings.HasSuffix(key, ".merge"):
			cfg.merge[strings.TrimSuffix(strings.TrimPrefix(key, "branch."), ".merge")] = val
		}
	}
	return cfg
}

// pushTarget is the remote a push of branch goes to, its url, and whether
// the branch already tracks its namesake there.
func (c remoteConfig) pushTarget(branch string) (remote, url string, published bool) {
	if r := c.remote[branch]; r != "" && c.urls[r] != "" {
		remote = r
	} else if c.urls["origin"] != "" {
		remote = "origin"
	} else if len(c.urls) == 1 {
		for r := range c.urls {
			remote = r
		}
	}
	if remote == "" {
		return "", "", false
	}
	published = branch != "" && c.remote[branch] == remote && c.merge[branch] == "refs/heads/"+branch
	return remote, c.urls[remote], published
}

// checkRelPath refuses a path that is not a plain path inside the worktree.
func checkRelPath(p string) error {
	if p == "" || strings.ContainsRune(p, 0) || (runtime.GOOS == "windows" && strings.Contains(p, `\`)) || !filepath.IsLocal(filepath.FromSlash(p)) || path0(p) != p {
		return changeErr(KindInvalid, "%q is not a path inside this worktree", p)
	}
	return nil
}

// path0 is p cleaned in slash form, as git writes paths.
func path0(p string) string {
	return strings.TrimPrefix(filepath.ToSlash(filepath.Clean(filepath.FromSlash(p))), "./")
}

// Diff is one file's patch: staged (index against HEAD) or not (worktree
// against index; a new file against nothing). path must be in the status.
func (s *Service) Diff(ctx context.Context, id int64, worktree, path string, staged bool) (FilePatch, error) {
	if err := checkRelPath(path); err != nil {
		return FilePatch{}, err
	}
	dir, err := s.WorktreePath(ctx, id, worktree)
	if err != nil {
		return FilePatch{}, err
	}
	st, err := s.readStatus(ctx, dir)
	if err != nil {
		return FilePatch{}, err
	}
	e, ok := findEntry(st.entries, path, staged)
	if !ok {
		return FilePatch{}, changeErr(KindStale, "%s has no %s changes now", path, area(staged))
	}
	return s.patchFor(ctx, dir, e, staged)
}

func area(staged bool) string {
	if staged {
		return "staged"
	}
	return "unstaged"
}

// findEntry is path's record in the area asked for.
func findEntry(entries []statusEntry, path string, staged bool) (statusEntry, bool) {
	for _, e := range entries {
		if e.path != path {
			continue
		}
		switch {
		case e.kind == 'u':
			return e, !staged
		case e.kind == '?':
			return e, !staged
		case staged && e.x != '.', !staged && e.y != '.':
			return e, true
		}
	}
	return statusEntry{}, false
}

func (s *Service) patchFor(ctx context.Context, dir string, e statusEntry, staged bool) (FilePatch, error) {
	fp := FilePatch{Path: e.path, Staged: staged}
	var args []string
	switch {
	case e.kind == '?':
		fp.Status = "untracked"
		full := filepath.Join(dir, filepath.FromSlash(e.path))
		if st, err := os.Lstat(full); err == nil && st.Size() > maxUntrackedDiff {
			fp.TooLarge, fp.Bytes = true, int(st.Size())
			return fp, nil
		}
		args = []string{"diff", "--no-color", "--no-ext-diff", "--no-index", "--", os.DevNull, e.path}
	case e.kind == 'u':
		fp.Status = "conflicted"
		args = []string{"diff", "--no-color", "--no-ext-diff", "--", e.path}
	case staged:
		fp.Status = letterStatus(e.x)
		args = []string{"diff", "--cached", "-M", "--no-color", "--no-ext-diff", "--"}
		if e.origPath != "" && (e.x == 'R' || e.x == 'C') {
			fp.OrigPath = e.origPath
			args = append(args, e.origPath)
		}
		args = append(args, e.path)
	default:
		fp.Status = letterStatus(e.y)
		args = []string{"diff", "--no-color", "--no-ext-diff", "--", e.path}
	}
	r, err := s.gitCmd(ctx, readOpts, dir, args...)
	// --no-index exits 1 whenever the two differ, which for a new file is
	// always; its output is the patch.
	if err != nil && (e.kind != '?' || len(r.out) == 0) {
		return FilePatch{}, err
	}
	patch := string(r.out)
	if e.kind == '?' {
		patch = strings.ReplaceAll(patch, "a/"+filepath.ToSlash(os.DevNull), "a/"+e.path)
	}
	fp.Bytes = len(patch)
	sum := sha256.Sum256(r.out)
	fp.Token = hex.EncodeToString(sum[:8])
	fp.Binary = isBinaryPatch(patch)
	if len(patch) > MaxPatchBytes {
		cut := strings.LastIndexByte(patch[:MaxPatchBytes], '\n')
		if cut < 0 {
			cut = MaxPatchBytes
		}
		patch, fp.Truncated = patch[:cut+1], true
	}
	fp.Patch = patch
	return fp, nil
}

func isBinaryPatch(p string) bool {
	head := p
	if i := strings.Index(p, "\n@@"); i >= 0 {
		head = p[:i]
	}
	return strings.Contains(head, "\nBinary files ") || strings.HasPrefix(head, "Binary files ") || strings.Contains(head, "GIT binary patch")
}

// Hunk names one hunk of a file's patch as the caller saw it.
type Hunk struct {
	Path  string `json:"path"`
	Index int    `json:"index"` // 0-based, in patch order
	Token string `json:"token"` // FilePatch.Token
}

// Stage adds files (paths, every change when all) or one hunk to the index.
func (s *Service) Stage(ctx context.Context, id int64, worktree string, paths []string, all bool, hunk *Hunk) (Changes, error) {
	return s.indexOp(ctx, id, worktree, func(dir string, st rawStatus) error {
		if hunk != nil {
			return s.applyHunk(ctx, dir, st, *hunk, false)
		}
		if all {
			_, err := s.gitCmd(ctx, indexOpts, dir, "add", "-A")
			return err
		}
		sel, err := selectPaths(st.entries, paths, func(e statusEntry) bool { return e.kind == '?' || e.kind == 'u' || e.y != '.' })
		if err != nil {
			return err
		}
		_, err = s.gitCmd(ctx, indexOpts, dir, append([]string{"add", "-A", "--"}, sel...)...)
		return err
	})
}

// Unstage takes files (paths, every staged change when all) or one hunk out
// of the index; the working tree is not touched.
func (s *Service) Unstage(ctx context.Context, id int64, worktree string, paths []string, all bool, hunk *Hunk) (Changes, error) {
	return s.indexOp(ctx, id, worktree, func(dir string, st rawStatus) error {
		if hunk != nil {
			return s.applyHunk(ctx, dir, st, *hunk, true)
		}
		born := st.oid != ""
		var sel []string
		if all {
			sel = []string{"."}
		} else {
			var err error
			sel, err = selectPaths(st.entries, paths, func(e statusEntry) bool { return e.kind != '?' && e.kind != 'u' && e.x != '.' })
			if err != nil {
				return err
			}
			// A rename is staged as two paths; both come out.
			for _, e := range st.entries {
				if e.origPath != "" && contains(sel, e.path) && !contains(sel, e.origPath) {
					sel = append(sel, e.origPath)
				}
			}
		}
		args := append([]string{"restore", "--staged", "--"}, sel...)
		if !born {
			args = append([]string{"rm", "--cached", "-r", "-q", "--"}, sel...)
		}
		_, err := s.gitCmd(ctx, indexOpts, dir, args...)
		return err
	})
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// indexOp runs one change to the index under the worktree's lock and
// answers with the status after it.
func (s *Service) indexOp(ctx context.Context, id int64, worktree string, op func(dir string, st rawStatus) error) (Changes, error) {
	dir, err := s.WorktreePath(ctx, id, worktree)
	if err != nil {
		return Changes{}, err
	}
	unlock := s.lockFor(dir)
	defer unlock()
	st, err := s.readStatus(ctx, dir)
	if err != nil {
		return Changes{}, err
	}
	if err := op(dir, st); err != nil {
		return Changes{}, err
	}
	go s.refreshNow(id)
	return s.changesAt(ctx, id, worktree, dir)
}

// selectPaths checks every path the caller sent against the status: each
// must be a change in the area asked for (ok), or the request is refused
// whole.
func selectPaths(entries []statusEntry, paths []string, ok func(statusEntry) bool) ([]string, error) {
	if len(paths) == 0 {
		return nil, changeErr(KindInvalid, "name the files (paths) or send all")
	}
	var out []string
	for _, p := range paths {
		if err := checkRelPath(p); err != nil {
			return nil, err
		}
		found := false
		for _, e := range entries {
			if e.path == p && ok(e) {
				found = true
				break
			}
		}
		if !found {
			return nil, changeErr(KindStale, "%s is not among this worktree's changes now; look again", p)
		}
		out = append(out, p)
	}
	return out, nil
}

// applyHunk stages (or, reverse, unstages) one hunk of a tracked file's
// patch, after checking the patch is still the one the caller saw.
func (s *Service) applyHunk(ctx context.Context, dir string, st rawStatus, h Hunk, reverse bool) error {
	if err := checkRelPath(h.Path); err != nil {
		return err
	}
	e, ok := findEntry(st.entries, h.Path, reverse)
	if !ok || e.kind == '?' || e.kind == 'u' {
		return changeErr(KindStale, "%s has no %s hunks now; look again", h.Path, area(reverse))
	}
	fp, err := s.patchFor(ctx, dir, e, reverse)
	if err != nil {
		return err
	}
	if fp.Token != h.Token {
		return changeErr(KindStale, "%s changed since you looked; review it again", h.Path)
	}
	patch, err := hunkPatch(fp, h.Index)
	if err != nil {
		return err
	}
	args := []string{"apply", "--cached", "--whitespace=nowarn"}
	if reverse {
		args = append(args, "--reverse")
	}
	_, err = s.gitCmd(ctx, gitOpts{timeout: indexTimeout, stdin: []byte(patch), literal: true}, dir, append(args, "-")...)
	return err
}

// hunkPatch is a file's header plus its hunk i alone: a patch git apply
// takes. Whole-file changes (new, deleted, renamed, binary, mode) are staged
// as files.
func hunkPatch(fp FilePatch, i int) (string, error) {
	if fp.Binary || fp.Truncated || fp.Status != "modified" {
		return "", changeErr(KindInvalid, "%s is staged as a whole file", fp.Path)
	}
	lines := strings.SplitAfter(fp.Patch, "\n")
	var header []string
	var hunks [][]string
	for _, l := range lines {
		if strings.HasPrefix(l, "@@") {
			hunks = append(hunks, []string{l})
			continue
		}
		if len(hunks) == 0 {
			if strings.HasPrefix(l, "old mode") || strings.HasPrefix(l, "new mode") {
				return "", changeErr(KindInvalid, "%s changes its mode; stage it as a whole file", fp.Path)
			}
			header = append(header, l)
			continue
		}
		hunks[len(hunks)-1] = append(hunks[len(hunks)-1], l)
	}
	if i < 0 || i >= len(hunks) {
		return "", changeErr(KindStale, "%s has no hunk %d now; look again", fp.Path, i+1)
	}
	return strings.Join(header, "") + strings.Join(hunks[i], ""), nil
}

// discardable is a change Discard may throw away: unstaged edits to a
// tracked file, or an untracked file. Staged work and conflicts are kept.
func discardable(e statusEntry) bool {
	return e.kind == '?' || (e.kind != 'u' && e.y != '.')
}

// confirmToken names exactly these files in exactly this state: their
// status records and their size and modification time on disk. A file an
// agent writes to between the look and the click changes it.
func confirmToken(dir string, sel []statusEntry) string {
	h := sha256.New()
	_, _ = io.WriteString(h, dir)
	for _, e := range sel {
		_, _ = io.WriteString(h, "\x00"+e.line)
		if st, err := os.Lstat(filepath.Join(dir, filepath.FromSlash(e.path))); err == nil {
			_, _ = fmt.Fprintf(h, "\x00%d\x00%d", st.Size(), st.ModTime().UnixNano())
		}
	}
	return hex.EncodeToString(h.Sum(nil)[:12])
}

// Discard throws away the unstaged changes to paths (tracked files go back
// to their staged or committed content; untracked files are deleted). It
// takes two calls: without confirm it changes nothing and returns what it
// would discard and a token; with that token, and nothing changed since, it
// discards. Staged changes are never touched.
func (s *Service) Discard(ctx context.Context, id int64, worktree string, paths []string, confirm string) (*DiscardPreview, Changes, error) {
	dir, err := s.WorktreePath(ctx, id, worktree)
	if err != nil {
		return nil, Changes{}, err
	}
	unlock := s.lockFor(dir)
	defer unlock()
	st, err := s.readStatus(ctx, dir)
	if err != nil {
		return nil, Changes{}, err
	}
	names, err := selectPaths(st.entries, paths, discardable)
	if err != nil {
		return nil, Changes{}, err
	}
	sort.Strings(names)
	var sel []statusEntry
	for _, p := range names {
		for _, e := range st.entries {
			if e.path == p && discardable(e) {
				sel = append(sel, e)
				break
			}
		}
	}
	preview := &DiscardPreview{Confirm: confirmToken(dir, sel)}
	for _, e := range sel {
		f := ChangeFile{Path: e.path, Status: "untracked"}
		if e.kind != '?' {
			f.Status = letterStatus(e.y)
		}
		preview.Files = append(preview.Files, f)
	}
	if confirm == "" {
		return preview, Changes{}, nil
	}
	if confirm != preview.Confirm {
		return nil, Changes{}, &ChangeError{Kind: KindStale, Message: "these files changed since you looked; review them again", Preview: preview}
	}
	var tracked []string
	for _, e := range sel {
		if e.kind == '?' {
			if err := removeUntracked(dir, e.path); err != nil {
				return nil, Changes{}, err
			}
			continue
		}
		tracked = append(tracked, e.path)
	}
	if len(tracked) > 0 {
		if _, err := s.gitCmd(ctx, indexOpts, dir, append([]string{"restore", "--worktree", "--"}, tracked...)...); err != nil {
			return nil, Changes{}, err
		}
	}
	go s.refreshNow(id)
	c, err := s.changesAt(ctx, id, worktree, dir)
	return nil, c, err
}

// removeUntracked deletes one untracked file (a link, not what it points
// at) and then any folders it leaves empty, up to the worktree.
func removeUntracked(dir, rel string) error {
	full := filepath.Join(dir, filepath.FromSlash(rel))
	// Every folder on the way must be a real folder inside the worktree, so a
	// link planted in the path cannot steer the delete elsewhere.
	parent := filepath.Dir(full)
	if real, err := filepath.EvalSymlinks(parent); err != nil || !within(real, dir) {
		return changeErr(KindInvalid, "%s is not inside this worktree", rel)
	}
	st, err := os.Lstat(full)
	if err != nil {
		return changeErr(KindStale, "%s is gone already", rel)
	}
	if st.IsDir() {
		return changeErr(KindInvalid, "%s is a folder", rel)
	}
	if err := os.Remove(full); err != nil {
		return changeErr(KindGit, "could not delete %s: %v", rel, err)
	}
	for d := parent; within(d, dir) && filepath.Clean(d) != filepath.Clean(dir); d = filepath.Dir(d) {
		if !removedEmpty(d) { // not empty, or not ours: stop
			break
		}
	}
	return nil
}

// removedEmpty removes folder d when it is empty, and says whether it did.
func removedEmpty(d string) bool { return os.Remove(d) == nil }

// within reports whether p is dir or below it, both resolved.
func within(p, dir string) bool {
	rd, err := filepath.EvalSymlinks(dir)
	if err != nil {
		rd = dir
	}
	rp, err := filepath.EvalSymlinks(p)
	if err != nil {
		rp = p
	}
	rel, err := filepath.Rel(rd, rp)
	return err == nil && (rel == "." || filepath.IsLocal(rel))
}

// CheckMessage refuses an empty or unreasonable commit message, and returns
// it with trailing space trimmed.
func CheckMessage(msg string) (string, error) {
	msg = strings.TrimRight(strings.ReplaceAll(msg, "\r\n", "\n"), " \t\n")
	switch {
	case strings.TrimSpace(msg) == "":
		return "", changeErr(KindInvalid, "write a commit message first")
	case len(msg) > maxMessage:
		return "", changeErr(KindInvalid, "a commit message is at most %d KB", maxMessage>>10)
	case strings.ContainsRune(msg, 0):
		return "", changeErr(KindInvalid, "a commit message cannot contain a NUL byte")
	}
	return msg + "\n", nil
}

// Commit commits what is staged (everything first, when all) with message,
// as the author git is configured with. Hooks run; a hook that refuses is a
// KindHook error carrying its output, and what was staged stays staged.
func (s *Service) Commit(ctx context.Context, id int64, worktree, message string, all bool) (CommitResult, Changes, error) {
	msg, err := CheckMessage(message)
	if err != nil {
		return CommitResult{}, Changes{}, err
	}
	dir, err := s.WorktreePath(ctx, id, worktree)
	if err != nil {
		return CommitResult{}, Changes{}, err
	}
	unlock := s.lockFor(dir)
	defer unlock()
	st, err := s.readStatus(ctx, dir)
	if err != nil {
		return CommitResult{}, Changes{}, err
	}
	for _, e := range st.entries {
		if e.kind == 'u' {
			return CommitResult{}, Changes{}, changeErr(KindState, "%s is in conflict; resolve it first", e.path)
		}
	}
	if all {
		if _, err := s.gitCmd(ctx, indexOpts, dir, "add", "-A"); err != nil {
			return CommitResult{}, Changes{}, err
		}
		if st, err = s.readStatus(ctx, dir); err != nil {
			return CommitResult{}, Changes{}, err
		}
	}
	staged := false
	for _, e := range st.entries {
		if e.kind != '?' && e.x != '.' {
			staged = true
			break
		}
	}
	if !staged {
		return CommitResult{}, Changes{}, changeErr(KindState, "nothing is staged to commit")
	}
	r, err := s.gitCmd(ctx, gitOpts{timeout: commitTimeout, stdin: []byte(msg), combined: true}, dir, "commit", "-F", "-")
	go s.refreshNow(id)
	if err != nil {
		var ce *ChangeError
		if errors.As(err, &ce) && ce.Kind == KindGit && s.hasHook(ctx, dir, "pre-commit", "commit-msg", "prepare-commit-msg") && !gitOwnRefusal(ce.Output) {
			ce.Kind = KindHook
			ce.Message = "a commit hook refused the commit; what was staged is still staged"
		}
		return CommitResult{}, Changes{}, err
	}
	res := CommitResult{Output: tail(strings.TrimSpace(string(r.out)))}
	if h, err := s.gitCmd(ctx, readOpts, dir, "log", "-1", "--format=%H%x00%h%x00%s"); err == nil {
		p := strings.SplitN(strings.TrimSpace(string(h.out)), "\x00", 3)
		if len(p) == 3 {
			res.SHA, res.Short, res.Subject = p[0], p[1], p[2]
		}
	}
	c, err := s.changesAt(ctx, id, worktree, dir)
	return res, c, err
}

// gitOwnRefusal reports whether a failed commit's output is git's own
// complaint (identity, signing) rather than a hook's.
func gitOwnRefusal(out string) bool {
	for _, m := range []string{"Please tell me who you are", "unable to auto-detect email address", "gpg failed to sign", "error: cannot run gpg", "nothing to commit", "empty ident name"} {
		if strings.Contains(out, m) {
			return true
		}
	}
	return false
}

// hasHook reports whether any of the named hooks is installed, wherever
// core.hooksPath puts them.
func (s *Service) hasHook(ctx context.Context, dir string, names ...string) bool {
	for _, n := range names {
		r, err := s.gitCmd(ctx, readOpts, dir, "rev-parse", "--git-path", "hooks/"+n)
		if err != nil {
			continue
		}
		p := strings.TrimSpace(string(r.out))
		if !filepath.IsAbs(p) {
			p = filepath.Join(dir, p)
		}
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
			return true
		}
	}
	return false
}

// classifyRemote names why a push, pull or fetch failed, from git's words.
func classifyRemote(out string) (kind, message string) {
	low := strings.ToLower(out)
	has := func(ms ...string) bool {
		for _, m := range ms {
			if strings.Contains(low, strings.ToLower(m)) {
				return true
			}
		}
		return false
	}
	switch {
	case has("authentication failed", "permission denied", "could not read username", "could not read password", "terminal prompts disabled",
		"invalid username or password", "requested url returned error: 401", "requested url returned error: 403", "host key verification failed",
		"support for password authentication was removed", "access denied", "403 forbidden"):
		return KindAuth, "the remote refused your credentials; sign in to it in a terminal once (ssh key, credential helper or token), then try again"
	case has("[rejected]", "non-fast-forward", "fetch first", "updates were rejected"):
		return KindRejected, "the remote has commits this branch does not; pull first (Caprock never force-pushes)"
	case has("not possible to fast-forward", "diverging branches", "cannot fast-forward"):
		return KindDiverged, "the branch and its upstream have both moved on; merge or rebase them in a terminal"
	case has("could not resolve host", "connection refused", "connection timed out", "operation timed out", "network is unreachable",
		"failed to connect", "could not connect", "connection reset", "unable to access", "could not read from remote repository"):
		return KindNetwork, "the remote could not be reached"
	case has("would be overwritten by merge", "commit your changes or stash them"):
		return KindState, "your uncommitted changes touch the same files; commit or discard them first"
	}
	return KindGit, ""
}

// remoteOp runs a push, pull or fetch and turns a failure into a classified
// ChangeError.
func (s *Service) remoteOp(ctx context.Context, dir string, hooks []string, args ...string) (string, error) {
	r, err := s.gitCmd(ctx, gitOpts{timeout: remoteTimeout, combined: true}, dir, args...)
	out := tail(strings.TrimSpace(string(r.out)))
	if err == nil {
		return out, nil
	}
	var ce *ChangeError
	if !errors.As(err, &ce) || ce.Kind == KindTimeout {
		return out, err
	}
	kind, msg := classifyRemote(ce.Output)
	if kind == KindGit && len(hooks) > 0 && s.hasHook(ctx, dir, hooks...) {
		kind, msg = KindHook, "the "+hooks[0]+" hook refused it"
	}
	ce.Kind = kind
	if msg != "" {
		ce.Message = msg
	}
	return out, ce
}

// Push sends the checked-out branch to the same-named branch on its remote,
// setting that as the upstream when it is not already (the first push of a
// new branch, or a worktree made to track the trunk). Never forced.
func (s *Service) Push(ctx context.Context, id int64, worktree string) (RemoteResult, Changes, error) {
	dir, err := s.WorktreePath(ctx, id, worktree)
	if err != nil {
		return RemoteResult{}, Changes{}, err
	}
	unlock := s.lockFor(dir)
	defer unlock()
	c, err := s.changesAt(ctx, id, worktree, dir)
	if err != nil {
		return RemoteResult{}, Changes{}, err
	}
	switch {
	case c.Detached || c.Branch == "":
		return RemoteResult{}, Changes{}, changeErr(KindState, "HEAD is not on a branch; check one out to push")
	case c.Head == "":
		return RemoteResult{}, Changes{}, changeErr(KindState, "this branch has no commits yet")
	case c.Remote == "":
		return RemoteResult{}, Changes{}, changeErr(KindState, "this repository has no remote to push to")
	}
	ref := "refs/heads/" + c.Branch
	args := []string{"push"}
	res := RemoteResult{Remote: c.Remote, Branch: c.Branch}
	if !c.Published {
		args = append(args, "--set-upstream")
		res.UpstreamSet = true
	}
	args = append(args, "--", c.Remote, ref+":"+ref)
	out, err := s.remoteOp(ctx, dir, []string{"pre-push"}, args...)
	go s.refreshNow(id)
	if err != nil {
		return RemoteResult{}, Changes{}, err
	}
	res.Output = out
	c, err = s.changesAt(ctx, id, worktree, dir)
	return res, c, err
}

// Pull fast-forwards the branch to its upstream, or says why it cannot.
func (s *Service) Pull(ctx context.Context, id int64, worktree string) (RemoteResult, Changes, error) {
	dir, err := s.WorktreePath(ctx, id, worktree)
	if err != nil {
		return RemoteResult{}, Changes{}, err
	}
	unlock := s.lockFor(dir)
	defer unlock()
	c, err := s.changesAt(ctx, id, worktree, dir)
	if err != nil {
		return RemoteResult{}, Changes{}, err
	}
	if c.Detached || c.Upstream == "" {
		return RemoteResult{}, Changes{}, changeErr(KindState, "this branch tracks no remote branch; push it first")
	}
	out, err := s.remoteOp(ctx, dir, nil, "pull", "--ff-only", "--no-rebase", "--no-edit")
	go s.refreshNow(id)
	if err != nil {
		return RemoteResult{}, Changes{}, err
	}
	c, err = s.changesAt(ctx, id, worktree, dir)
	return RemoteResult{Remote: c.Remote, Branch: c.Branch, Output: out}, c, err
}

// Fetch updates what the worktree knows of its remote, so ahead and behind
// are current.
func (s *Service) Fetch(ctx context.Context, id int64, worktree string) (RemoteResult, Changes, error) {
	dir, err := s.WorktreePath(ctx, id, worktree)
	if err != nil {
		return RemoteResult{}, Changes{}, err
	}
	unlock := s.lockFor(dir)
	defer unlock()
	c, err := s.changesAt(ctx, id, worktree, dir)
	if err != nil {
		return RemoteResult{}, Changes{}, err
	}
	if c.Remote == "" {
		return RemoteResult{}, Changes{}, changeErr(KindState, "this repository has no remote to fetch from")
	}
	out, err := s.remoteOp(ctx, dir, nil, "fetch", "--prune", "--", c.Remote)
	go s.refreshNow(id)
	if err != nil {
		return RemoteResult{}, Changes{}, err
	}
	c, err = s.changesAt(ctx, id, worktree, dir)
	return RemoteResult{Remote: c.Remote, Output: out}, c, err
}
