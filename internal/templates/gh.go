package templates

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/hidewin"
	"github.com/dspv/caprock/internal/projects"
)

// GHStatus is whether the person's own GitHub CLI can make a repository:
// installed, and signed in to github.com as login. Read from gh's own
// config on this machine; nothing is sent and the token is never read.
type GHStatus struct {
	Installed bool   `json:"installed"`
	LoggedIn  bool   `json:"logged_in"`
	Login     string `json:"login,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Ready reports whether the GitHub path can be taken.
func (g GHStatus) Ready() bool { return g.Installed && g.LoggedIn && g.Login != "" }

// errGHMissing is gh not installed, or not on the login shell's PATH.
var errGHMissing = errors.New("the GitHub CLI (gh) is not installed, or not on your login shell's PATH")

// githubLogin is a GitHub user name.
var githubLogin = regexp.MustCompile(`^[A-Za-z0-9-]{1,39}$`)

// env is the login shell's environment with gh and git told never to ask
// anything, never to check for updates and never to colour their output.
func (s *Service) env() []string {
	env := os.Environ()
	if s.Env != nil {
		env = s.Env()
	}
	return append(append([]string{}, env...),
		"GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1", "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
}

// ghPath finds gh: GHBin, else the login PATH, else Homebrew's places.
func (s *Service) ghPath(env []string) (string, error) {
	if s.GHBin != "" {
		if isExec(s.GHBin) {
			return s.GHBin, nil
		}
		return "", errGHMissing
	}
	name := "gh"
	if runtime.GOOS == "windows" {
		name = "gh.exe"
	}
	for _, kv := range env {
		if p, ok := strings.CutPrefix(kv, "PATH="); ok {
			for _, dir := range filepath.SplitList(p) {
				if c := filepath.Join(dir, name); isExec(c) {
					return c, nil
				}
			}
		}
	}
	for _, c := range []string{"/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"} {
		if isExec(c) {
			return c, nil
		}
	}
	return "", errGHMissing
}

func isExec(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir() && (runtime.GOOS == "windows" || st.Mode()&0o111 != 0)
}

// gh runs one gh command under timeout and returns its stdout; a failure
// carries gh's own first lines.
func (s *Service) gh(ctx context.Context, timeout time.Duration, args ...string) ([]byte, error) {
	env := s.env()
	bin, err := s.ghPath(env)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := hidewin.CommandContext(ctx, bin, args...) //nolint:gosec // fixed subcommands; names checked
	cmd.Env = env
	cmd.WaitDelay = time.Second
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err = cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("gh %s did not answer within %s", args[0], timeout)
	}
	if err != nil {
		return nil, errors.New(firstLines(errb.String(), err))
	}
	return out.Bytes(), nil
}

// firstLines is the first three non-empty lines of a command's stderr, or
// err when it printed nothing.
func firstLines(stderr string, err error) string {
	var keep []string
	for _, l := range strings.Split(stderr, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			keep = append(keep, l)
			if len(keep) == 3 {
				break
			}
		}
	}
	if len(keep) == 0 {
		return err.Error()
	}
	return strings.Join(keep, "\n")
}

// GH reads whether gh is installed and signed in, from gh's own config on
// this machine (`gh config get -h github.com user`): nothing goes to GitHub.
func (s *Service) GH(ctx context.Context) GHStatus {
	if _, err := s.ghPath(s.env()); err != nil {
		return GHStatus{Error: err.Error()}
	}
	st := GHStatus{Installed: true}
	out, err := s.gh(ctx, 5*time.Second, "config", "get", "-h", "github.com", "user")
	login := strings.TrimSpace(string(out))
	switch {
	case err != nil || login == "":
		st.Error = "gh is not signed in to github.com; run `gh auth login` in a terminal"
	case !githubLogin.MatchString(login):
		st.Error = "gh names a GitHub user that is not one: " + firstLine(login)
	default:
		st.LoggedIn, st.Login = true, login
	}
	return st
}

func firstLine(s string) string {
	l, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return l
}

// ghClone runs `gh repo clone <repo> <dest> -- --progress` in dest's parent,
// sending git's progress to progress.
func (s *Service) ghClone(ctx context.Context, repo, dest string, progress func(phase string, pct int)) error {
	env := s.env()
	bin, err := s.ghPath(env)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	cmd := hidewin.CommandContext(ctx, bin, "repo", "clone", repo, dest, "--", "--progress") //nolint:gosec // repo and dest checked
	cmd.Env = env
	cmd.Dir = filepath.Dir(dest)
	cmd.WaitDelay = 5 * time.Second
	return runProgress(cmd, progress)
}

// runProgress runs cmd, turning git's progress lines on stderr into calls to
// progress at most four a second; a failure carries the last lines printed.
func runProgress(cmd interface {
	StderrPipe() (io.ReadCloser, error)
	Start() error
	Wait() error
}, progress func(string, int),
) error {
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	var tail []string
	last, lastPhase, lastPct := time.Time{}, "", -1
	sc := bufio.NewScanner(stderr)
	sc.Split(projects.SplitCRLF)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if phase, pct, ok := projects.ParseGitProgress(line); ok {
			if (phase == lastPhase && pct == lastPct) || (time.Since(last) < 250*time.Millisecond && pct < 100) {
				continue
			}
			last, lastPhase, lastPct = time.Now(), phase, pct
			progress(phase, pct)
			continue
		}
		tail = append(tail, line)
		if len(tail) > 5 {
			tail = tail[1:]
		}
	}
	_, _ = io.Copy(io.Discard, stderr)
	if err := cmd.Wait(); err != nil {
		if len(tail) == 0 {
			return err
		}
		return errors.New(strings.Join(tail, "\n"))
	}
	return nil
}
