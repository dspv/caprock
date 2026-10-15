package templates

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/hidewin"
	"github.com/dspv/caprock/internal/projects"
	"github.com/dspv/caprock/internal/store"
)

// The two ways a project is made from a template. The request names one;
// the daemon never takes the other on its own.
const (
	ViaGitHub = "github" // gh repo create --template, then gh repo clone
	ViaLocal  = "local"  // the template folder's last commit, copied, then git init
)

// The steps of an operation, as Op.Step names them.
const (
	StepCreate = "create"
	StepClone  = "clone"
	StepCopy   = "copy"
	StepBrief  = "brief"
	StepCommit = "commit"
	StepAdd    = "add"
)

// OpKind is the kind of a template operation.
const OpKind = "template"

// MaxBrief is the largest brief, in bytes of UTF-8.
const MaxBrief = 1 << 20

// cloneTries is how many times a fresh repository is cloned before giving up:
// GitHub fills a repository made from a template a moment after it exists,
// so the first clone can come back empty.
const cloneTries = 6

// validName is a new project's folder and repository name.
var validName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)

// Source is the template a project is made from.
type Source struct {
	GitHub string `json:"github,omitempty"`
	Folder string `json:"folder,omitempty"`
}

// CreateRequest is POST /v1/projects/from-template.
type CreateRequest struct {
	OpID         string `json:"op_id"`
	Source       Source `json:"source"`
	Via          string `json:"via"`
	Name         string `json:"name"`
	Parent       string `json:"parent"`
	Visibility   string `json:"visibility"` // private (default) | public; GitHub only
	Brief        string `json:"brief"`
	BriefPath    string `json:"brief_path"`
	TemplateName string `json:"template_name"`
}

// Error is a refusal with the HTTP status it answers with.
type Error struct {
	Status int
	Msg    string
}

func (e *Error) Error() string { return e.Msg }

func refuse(status int, format string, a ...any) error {
	return &Error{Status: status, Msg: fmt.Sprintf(format, a...)}
}

// final is a failure trying again would only repeat.
type final struct{ error }

func (f final) Unwrap() error { return f.error }

// Service makes projects from templates.
type Service struct {
	Store    *Store
	Projects *projects.Service
	Log      *slog.Logger
	// Env is the login shell's environment, so gh, git, ssh keys and git's
	// identity are found as in a terminal; os.Environ when nil.
	Env func() []string
	// GHBin is gh's path (tests); found on the login PATH when empty.
	GHBin string
	// CloneWait is the pause before cloning a fresh repository again (2 s).
	CloneWait time.Duration
	// Ctx is the daemon's life: an operation outlives its request.
	Ctx context.Context

	mu   sync.Mutex
	jobs map[string]*job
	busy map[string]string // destination -> the op making it
}

// New is a Service over a store and the projects list.
func New(st *Store, projs *projects.Service, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{Store: st, Projects: projs, Log: log, CloneWait: 2 * time.Second}
}

// job is what an operation needs to run, and to run again.
type job struct {
	req         CreateRequest
	dest        string
	login       string
	repo        string // login/name, once the GitHub repository is named
	repoCreated bool
	madeDir     bool // dest did not exist: a failure removes it, rather than emptying it
}

// tilde writes p with the home folder as ~, as the person would type it.
func tilde(p string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return p
	}
	if rel, err := filepath.Rel(home, p); err == nil && filepath.IsLocal(rel) {
		return "~" + string(filepath.Separator) + rel
	}
	return p
}

// FromTemplate checks a request and starts making the project, returning
// the operation at once. An op_id already known returns that operation with
// existing true and starts nothing.
func (s *Service) FromTemplate(ctx context.Context, req CreateRequest) (projects.Op, bool, error) {
	if s.Projects == nil {
		return projects.Op{}, false, refuse(http.StatusNotImplemented, "projects are unavailable")
	}
	if req.OpID == "" {
		req.OpID = projects.NewOpID()
	}
	if !projects.ValidOpID(req.OpID) {
		return projects.Op{}, false, refuse(http.StatusBadRequest, "op_id is 1 to 64 letters, digits, - or _")
	}
	if op, ok := s.Projects.GetOp(req.OpID); ok {
		return op, true, nil
	}
	j, err := s.check(ctx, &req)
	if err != nil {
		return projects.Op{}, false, err
	}
	s.mu.Lock()
	if s.jobs == nil {
		s.jobs, s.busy = map[string]*job{}, map[string]string{}
	}
	for id := range s.jobs {
		if _, ok := s.Projects.GetOp(id); !ok { // forgotten an hour after it ended
			delete(s.jobs, id)
		}
	}
	if other, ok := s.busy[pathKey(j.dest)]; ok && other != req.OpID {
		s.mu.Unlock()
		return projects.Op{}, false, refuse(http.StatusConflict, "%s is being made already", tilde(j.dest))
	}
	op := projects.Op{ID: req.OpID, Kind: OpKind, Phase: "Starting", Dest: j.dest}
	if req.Via == ViaGitHub {
		op.Step, op.URL, op.Repo = StepCreate, "https://github.com/"+req.Source.GitHub, j.repo
	} else {
		op.Step, op.URL = StepCopy, req.Source.Folder
	}
	op, existing := s.Projects.StartOp(op)
	if existing {
		s.mu.Unlock()
		return op, true, nil
	}
	s.jobs[req.OpID] = j
	s.busy[pathKey(j.dest)] = req.OpID
	s.mu.Unlock()
	s.Log.Info("making a project from a template", "component", "templates", "op", req.OpID, "via", req.Via, "template", req.TemplateName, "dest", j.dest)
	go s.run(req.OpID, j)
	return op, false, nil
}

// pathKey is a destination as the busy map compares it.
func pathKey(p string) string { return strings.ToLower(filepath.Clean(p)) }

// check validates a request and works out its destination.
func (s *Service) check(ctx context.Context, req *CreateRequest) (*job, error) {
	bad := func(format string, a ...any) error { return refuse(http.StatusBadRequest, format, a...) }
	if req.Via != ViaGitHub && req.Via != ViaLocal {
		return nil, bad(`via is "github" or "local"`)
	}
	if !validName.MatchString(req.Name) || req.Name == "." || req.Name == ".." {
		return nil, bad("name is 1 to 100 letters, digits, '.', '-' or '_'")
	}
	if strings.TrimSpace(req.Brief) == "" {
		return nil, bad("write the brief")
	}
	if len(req.Brief) > MaxBrief {
		return nil, bad("the brief is longer than 1 MiB")
	}
	if !utf8.ValidString(req.Brief) || strings.ContainsRune(req.Brief, 0) {
		return nil, bad("the brief is not plain UTF-8 text")
	}
	if err := CheckBriefPath(req.BriefPath); err != nil {
		return nil, bad("%s", err.Error())
	}
	req.TemplateName = strings.TrimSpace(req.TemplateName)
	if utf8.RuneCountInString(req.TemplateName) > MaxNameRunes {
		return nil, bad("template_name is longer than %d characters", MaxNameRunes)
	}
	parent := projects.ExpandHome(strings.TrimSpace(req.Parent))
	if parent == "" || !filepath.IsAbs(parent) {
		return nil, bad("parent %q is not an absolute path", req.Parent)
	}
	parent = filepath.Clean(parent)
	if fi, err := os.Stat(parent); err == nil && !fi.IsDir() {
		return nil, bad("%s is not a folder", parent)
	}
	dest := filepath.Join(parent, req.Name)
	j := &job{req: *req, dest: dest}
	fi, err := os.Lstat(dest)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		j.madeDir = true
	case err != nil:
		return nil, bad("%s: %v", tilde(dest), err)
	case !fi.IsDir() || !projects.EmptyDir(dest):
		return nil, refuse(http.StatusConflict, "%s already exists; add it instead, or pick another name", tilde(dest))
	}
	switch req.Via {
	case ViaGitHub:
		req.Source.GitHub = strings.TrimSpace(req.Source.GitHub)
		if err := CheckGitHub(req.Source.GitHub); err != nil {
			return nil, bad("source.github: %s", err.Error())
		}
		switch req.Visibility {
		case "":
			req.Visibility = "private"
		case "private", "public":
		default:
			return nil, bad(`visibility is "private" or "public"`)
		}
		gh := s.GH(ctx)
		if !gh.Ready() {
			return nil, refuse(http.StatusConflict, "%s", gh.Error)
		}
		j.login, j.repo = gh.Login, gh.Login+"/"+req.Name
	case ViaLocal:
		if strings.TrimSpace(req.Source.Folder) == "" {
			return nil, bad("source.folder is needed to make it from a folder")
		}
		f, err := checkFolder(req.Source.Folder, true)
		if err != nil {
			return nil, bad("source.folder: %s", err.Error())
		}
		req.Source.Folder = f
		if rel, err := filepath.Rel(f, dest); err == nil && (rel == "." || filepath.IsLocal(rel)) {
			return nil, bad("the new project cannot go inside the template folder")
		}
	}
	j.req = *req
	// Made last, after every check: git clone makes the folders on its way
	// too, and a destination typed in full should not fail for a parent
	// nobody had a reason to make first.
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return nil, bad("could not make %s: %v", parent, err)
	}
	return j, nil
}

// Retry runs a failed, retryable operation again from the step it failed
// at; a GitHub repository already made is cloned, not made again.
func (s *Service) Retry(ctx context.Context, opID string) (projects.Op, error) {
	if s.Projects == nil {
		return projects.Op{}, refuse(http.StatusNotImplemented, "projects are unavailable")
	}
	op, ok := s.Projects.GetOp(opID)
	s.mu.Lock()
	j := s.jobs[opID]
	s.mu.Unlock()
	if !ok {
		return projects.Op{}, refuse(http.StatusNotFound, "no such operation; it may have ended over an hour ago, or before Caprock restarted")
	}
	if j == nil || op.Kind != OpKind || op.State != projects.OpFailed || !op.Retryable {
		return projects.Op{}, refuse(http.StatusConflict, "this operation cannot be tried again (%s)", op.State)
	}
	fi, err := os.Lstat(j.dest)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		j.madeDir = true
	case err != nil || !fi.IsDir() || !projects.EmptyDir(j.dest):
		return projects.Op{}, refuse(http.StatusConflict, "%s already exists; add it instead, or pick another name", tilde(j.dest))
	default:
		j.madeDir = false // made empty since, by someone else: emptied, never removed
	}
	if j.req.Via == ViaGitHub {
		gh := s.GH(ctx)
		if !gh.Ready() {
			return projects.Op{}, refuse(http.StatusConflict, "%s", gh.Error)
		}
		if j.repoCreated && !strings.EqualFold(gh.Login, j.login) {
			return projects.Op{}, refuse(http.StatusConflict, "gh is signed in as %s now; %s was made as %s", gh.Login, j.repo, j.login)
		}
		j.login = gh.Login
		if !j.repoCreated {
			j.repo = gh.Login + "/" + j.req.Name
		}
	}
	if err := os.MkdirAll(filepath.Dir(j.dest), 0o755); err != nil {
		return projects.Op{}, refuse(http.StatusConflict, "could not make %s: %v", filepath.Dir(j.dest), err)
	}
	s.mu.Lock()
	if other, ok := s.busy[pathKey(j.dest)]; ok && other != opID {
		s.mu.Unlock()
		return projects.Op{}, refuse(http.StatusConflict, "%s is being made already", tilde(j.dest))
	}
	s.busy[pathKey(j.dest)] = opID
	s.mu.Unlock()
	step := StepCopy
	if j.req.Via == ViaGitHub {
		step = StepClone
		if !j.repoCreated {
			step = StepCreate
		}
	}
	op, _ = s.Projects.UpdateOp(opID, func(o *projects.Op) {
		o.State, o.Error, o.Retryable, o.Removed, o.Notes = projects.OpRunning, "", false, false, nil
		o.Phase, o.Progress, o.Step, o.Repo = "Starting", 0, step, j.repo
	})
	s.Log.Info("trying a template project again", "component", "templates", "op", opID, "step", step)
	go s.run(opID, j)
	return op, nil
}

func (s *Service) ctx() context.Context {
	if s.Ctx != nil {
		return s.Ctx
	}
	return context.Background()
}

func (s *Service) step(opID, step string) {
	s.Projects.UpdateOp(opID, func(o *projects.Op) { o.Step, o.Phase, o.Progress = step, "", 0 })
}

func (s *Service) note(opID, note string) {
	s.Projects.UpdateOp(opID, func(o *projects.Op) { o.Notes = append(o.Notes, note) })
}

// run makes the project, step by step, and ends the operation.
func (s *Service) run(opID string, j *job) {
	ctx := s.ctx()
	var err error
	identity := true
	if j.req.Via == ViaGitHub {
		err = s.fromGitHub(ctx, opID, j)
	} else {
		identity, err = s.fromFolder(ctx, opID, j)
	}
	if err == nil {
		s.step(opID, StepBrief)
		if err = writeBrief(j.dest, j.req.BriefPath, j.req.Brief); err != nil {
			err = final{fmt.Errorf("the brief was not written: %w", err)}
		}
	}
	if err != nil {
		s.fail(opID, j, err)
		return
	}
	s.step(opID, StepCommit)
	if identity {
		if msg := s.commit(ctx, j.dest, "Add the project brief", j.req.BriefPath); msg != "" {
			s.note(opID, msg)
		}
	} else {
		s.note(opID, "The brief is written but not committed: git has no name and email here. Set them with git config --global user.name and user.email, then commit it.")
	}
	s.step(opID, StepAdd)
	source := store.ProjectSourceNew
	if j.req.Via == ViaGitHub {
		source = store.ProjectSourceClone
	}
	v, lerr := s.Projects.ListCreated(ctx, j.dest, source)
	if lerr != nil {
		s.note(opID, "The project is made but could not be listed ("+lerr.Error()+"); add "+tilde(j.dest)+" by hand.")
	}
	if s.Store != nil && j.req.TemplateName != "" {
		s.Store.MarkUsed(j.req.TemplateName)
	}
	s.release(opID, j, false)
	s.Projects.FinishOp(opID, v.ID, nil)
}

// release frees the destination, and the job too unless it may run again
// (a job that never will lets its brief go). It comes before the op ends, so
// a Retry that sees the end finds everything settled.
func (s *Service) release(opID string, j *job, keep bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.busy[pathKey(j.dest)] == opID {
		delete(s.busy, pathKey(j.dest))
	}
	if !keep {
		delete(s.jobs, opID)
	}
}

// fromGitHub makes the repository from the template with the person's gh
// and clones it into dest.
func (s *Service) fromGitHub(ctx context.Context, opID string, j *job) error {
	if !j.repoCreated {
		s.step(opID, StepCreate)
		vis := "--private"
		if j.req.Visibility == "public" {
			vis = "--public"
		}
		if _, err := s.gh(ctx, 2*time.Minute, "repo", "create", j.repo, "--template", j.req.Source.GitHub, vis); err != nil {
			if strings.Contains(strings.ToLower(err.Error()), "already exists") {
				return final{fmt.Errorf("github.com/%s already exists; pick another name", j.repo)}
			}
			return fmt.Errorf("gh could not make github.com/%s: %w", j.repo, err)
		}
		j.repoCreated = true
		s.Projects.UpdateOp(opID, func(o *projects.Op) { o.Repo, o.RepoURL = j.repo, "https://github.com/"+j.repo })
		s.Log.Info("made a repository from a template", "component", "templates", "op", opID, "repo", j.repo, "template", j.req.Source.GitHub)
	}
	s.step(opID, StepClone)
	var err error
	for try := 1; try <= cloneTries; try++ {
		err = s.ghClone(ctx, j.repo, j.dest, func(phase string, pct int) {
			s.Projects.UpdateOp(opID, func(o *projects.Op) { o.Phase, o.Progress = phase, pct })
		})
		if err == nil {
			if _, herr := s.git(ctx, j.dest, time.Minute, "rev-parse", "--verify", "-q", "HEAD"); herr == nil {
				return nil
			}
			err = fmt.Errorf("github.com/%s was still empty after %d tries; GitHub may still be filling it in", j.repo, try)
		}
		if try == cloneTries {
			break
		}
		s.clean(j)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.CloneWait):
		}
	}
	return err
}

// fromFolder copies the template folder into dest — a repository's last
// commit, or the folder's files — and commits them in a new repository. It
// reports whether git has an identity to commit with.
func (s *Service) fromFolder(ctx context.Context, opID string, j *job) (bool, error) {
	s.step(opID, StepCopy)
	if !mkdirNoLink(j.dest) {
		return true, fmt.Errorf("could not make %s", j.dest)
	}
	c, err := newCopier(j.dest)
	if err != nil {
		return true, err
	}
	src := j.req.Source.Folder
	if s.isRepoRoot(ctx, src) {
		err = s.copyArchive(ctx, src, c)
	} else {
		err = copyFolder(src, c)
	}
	if errors.Is(err, errTooBig) {
		return true, final{err}
	}
	if err != nil {
		return true, err
	}
	if c.skipped > 0 {
		s.note(opID, strconv.Itoa(c.skipped)+" links or special files in the template were not copied: a link is kept only when it is relative and stays inside the project.")
	}
	if _, err := s.git(ctx, j.dest, time.Minute, "init", "-q"); err != nil {
		return true, fmt.Errorf("git init: %w", err)
	}
	msg := "Start from a template"
	if j.req.TemplateName != "" {
		msg = "Start from the " + j.req.TemplateName + " template"
	}
	if _, err := s.git(ctx, j.dest, 5*time.Minute, "add", "-A"); err != nil {
		return true, fmt.Errorf("git add: %w", err)
	}
	if _, err := s.git(ctx, j.dest, 5*time.Minute, "commit", "-q", "--no-verify", "-m", msg); err != nil {
		if noIdentity(err) {
			return false, nil
		}
		s.note(opID, "The template's files are not committed: "+firstLine(err.Error()))
	}
	return true, nil
}

// isRepoRoot reports whether dir is the top of a repository with a commit:
// then its last commit is what is copied. A folder inside a repository is
// copied as files, or the whole repository would come with it.
func (s *Service) isRepoRoot(ctx context.Context, dir string) bool {
	if _, err := s.git(ctx, dir, time.Minute, "rev-parse", "--verify", "-q", "HEAD"); err != nil {
		return false
	}
	prefix, err := s.git(ctx, dir, time.Minute, "rev-parse", "--show-prefix")
	return err == nil && strings.TrimSpace(prefix) == ""
}

// commit commits path alone with msg; "" when it did, else what to tell
// the person. Nothing is ever pushed.
func (s *Service) commit(ctx context.Context, dir, msg, path string) string {
	if _, err := s.git(ctx, dir, time.Minute, "add", "--", path); err != nil {
		return "The brief is written but not committed: " + firstLine(err.Error())
	}
	if _, err := s.git(ctx, dir, time.Minute, "commit", "-q", "--no-verify", "-m", msg, "--", path); err != nil {
		if noIdentity(err) {
			return "The brief is written but not committed: git has no name and email here. Set them with git config --global user.name and user.email, then commit it."
		}
		return "The brief is written but not committed: " + firstLine(err.Error())
	}
	return ""
}

// noIdentity reports whether git refused a commit for want of a name and
// email.
func noIdentity(err error) bool {
	m := strings.ToLower(err.Error())
	return strings.Contains(m, "tell me who you are") || strings.Contains(m, "empty ident") ||
		strings.Contains(m, "unable to auto-detect") || strings.Contains(m, "useconfigonly") ||
		strings.Contains(m, "no email was given") || strings.Contains(m, "no name was given")
}

// git runs one git command in dir and returns its stdout.
func (s *Service) git(ctx context.Context, dir string, timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := hidewin.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...) //nolint:gosec // fixed subcommands
	cmd.Env = s.env()
	cmd.WaitDelay = time.Second
	var out, errb strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return "", fmt.Errorf("git %s did not answer within %s", args[0], timeout)
		}
		return "", errors.New(firstLines(errb.String(), err))
	}
	return out.String(), nil
}

// clean takes away what Caprock put at dest: the folder, when Caprock made
// it, or its contents, when the person had made it empty. It reports
// whether anything was there.
func (s *Service) clean(j *job) bool {
	if j.madeDir {
		if _, err := os.Lstat(j.dest); err != nil {
			return false
		}
		if err := os.RemoveAll(j.dest); err != nil {
			s.Log.Warn("could not remove a half-made project", "component", "templates", "dest", j.dest, "err", err)
		}
		return true
	}
	entries, err := os.ReadDir(j.dest)
	if err != nil || len(entries) == 0 {
		return false
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(j.dest, e.Name())); err != nil {
			s.Log.Warn("could not empty a half-made project", "component", "templates", "dest", j.dest, "err", err)
		}
	}
	return true
}

// fail cleans up what Caprock made on this machine and ends the operation.
// A GitHub repository is never deleted.
func (s *Service) fail(opID string, j *job, err error) {
	removed := s.clean(j)
	var f final
	retryable := !errors.As(err, &f) && s.ctx().Err() == nil
	s.Projects.UpdateOp(opID, func(o *projects.Op) {
		o.Retryable, o.Removed = retryable, removed
		if removed {
			if j.madeDir {
				o.Notes = append(o.Notes, "The folder "+tilde(j.dest)+" was removed again.")
			} else {
				o.Notes = append(o.Notes, "The folder "+tilde(j.dest)+" was emptied again; it is kept, as you made it.")
			}
		}
		if j.repoCreated {
			if retryable {
				o.Notes = append(o.Notes, "github.com/"+j.repo+" was made and is kept; Retry clones it again.")
			} else {
				o.Notes = append(o.Notes, "github.com/"+j.repo+" was made and is kept; Caprock never deletes a repository.")
			}
		}
	})
	s.release(opID, j, retryable)
	s.Projects.FinishOp(opID, 0, err)
}

// writeBrief writes text at dest/rel. Every folder on the way is made or
// must be a real folder inside dest — a link that resolves outside is
// refused — and an existing link at the file itself is never written
// through.
func writeBrief(dest, rel, text string) error {
	root, err := filepath.EvalSymlinks(dest)
	if err != nil {
		return err
	}
	segs := strings.Split(rel, "/")
	dir := root
	for _, seg := range segs[:len(segs)-1] {
		next := filepath.Join(dir, seg)
		fi, err := os.Lstat(next)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			if err := os.Mkdir(next, 0o755); err != nil {
				return err
			}
		case err != nil:
			return err
		case fi.Mode()&fs.ModeSymlink != 0:
			real, err := filepath.EvalSymlinks(next)
			if err != nil {
				return err
			}
			back, err := filepath.Rel(root, real)
			if err != nil || !filepath.IsLocal(back) {
				return fmt.Errorf("%s is a link that leads outside the project", seg)
			}
			if st, err := os.Stat(real); err != nil || !st.IsDir() {
				return fmt.Errorf("%s is not a folder", seg)
			}
			next = real
		case !fi.IsDir():
			return fmt.Errorf("%s is a file, not a folder", seg)
		}
		dir = next
	}
	file := filepath.Join(dir, segs[len(segs)-1])
	if fi, err := os.Lstat(file); err == nil && !fi.Mode().IsRegular() {
		return fmt.Errorf("%s is already there and is not a plain file", rel)
	}
	return os.WriteFile(file, []byte(text), 0o644) //nolint:gosec // a project file, readable like any other
}
