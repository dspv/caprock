package projects

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/store"
)

// Op is a long operation — a clone — that outlives the request and the
// connection that asked for it. A client names it with an op_id of its own;
// asking again with the same id returns the same operation, so a phone that
// dropped mid-clone and retries does not start a second one. Its progress
// goes out as op frames on /v1/live, and GET /v1/projects/ops answers what
// a reconnecting client missed.
type Op struct {
	ID        string `json:"op_id"`
	Kind      string `json:"kind"`            // clone
	State     string `json:"state"`           // running | done | failed
	Phase     string `json:"phase,omitempty"` // git's words: "Receiving objects", "Resolving deltas", …
	Progress  int    `json:"progress"`        // 0–100 within the phase
	URL       string `json:"url,omitempty"`
	Dest      string `json:"dest,omitempty"`
	ProjectID int64  `json:"project_id,omitempty"` // set when done
	Error     string `json:"error,omitempty"`
	StartedAt int64  `json:"started_at"`
	UpdatedAt int64  `json:"updated_at"`
}

// Op states.
const (
	OpRunning = "running"
	OpDone    = "done"
	OpFailed  = "failed"
)

// opKeep is how long a finished op is remembered for a client that comes
// back late.
const opKeep = time.Hour

type opRegistry struct {
	mu  sync.Mutex
	ops map[string]*Op
}

func newOpRegistry() *opRegistry { return &opRegistry{ops: map[string]*Op{}} }

// Ops lists the operations still remembered, newest first.
func (s *Service) Ops() []Op {
	s.ops.mu.Lock()
	defer s.ops.mu.Unlock()
	s.ops.pruneLocked(s.Now())
	out := make([]Op, 0, len(s.ops.ops))
	for _, o := range s.ops.ops {
		out = append(out, *o)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt > out[j].StartedAt })
	return out
}

// GetOp returns one operation.
func (s *Service) GetOp(id string) (Op, bool) {
	s.ops.mu.Lock()
	defer s.ops.mu.Unlock()
	o, ok := s.ops.ops[id]
	if !ok {
		return Op{}, false
	}
	return *o, true
}

func (r *opRegistry) pruneLocked(now time.Time) {
	for id, o := range r.ops {
		if o.State != OpRunning && now.Sub(time.UnixMilli(o.UpdatedAt)) > opKeep {
			delete(r.ops, id)
		}
	}
}

// validOpID is what a client may name an operation: short, plain.
var validOpID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// scpLike is git's `user@host:path` form for ssh.
var scpLike = regexp.MustCompile(`^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$`)

// CheckCloneURL accepts an https:// URL or git's user@host:path ssh form —
// nothing else, so a clone can never name a local path, a file:// URL or a
// transport that runs a command (ext::).
func CheckCloneURL(raw string) error {
	if raw == "" || len(raw) > 2048 || strings.HasPrefix(raw, "-") || strings.ContainsAny(raw, " \t\r\n\x00") {
		return fmt.Errorf("%q is not a repository address", raw)
	}
	if scpLike.MatchString(raw) {
		host := raw[strings.IndexByte(raw, '@')+1 : strings.IndexByte(raw, ':')]
		if strings.HasPrefix(host, "-") {
			return fmt.Errorf("%q is not a repository address", raw)
		}
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || strings.Trim(u.Path, "/") == "" {
		return errors.New("clone an https:// address or git@host:owner/repo")
	}
	return nil
}

// repoNameFromURL is the folder git would clone into: the last path segment
// without `.git`.
func repoNameFromURL(raw string) string {
	p := raw
	if u, err := url.Parse(raw); err == nil && u.Scheme == "https" {
		p = u.Path
	} else if i := strings.IndexByte(raw, ':'); i >= 0 {
		p = raw[i+1:]
	}
	p = strings.TrimRight(p, "/")
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		p = p[i+1:]
	}
	return strings.TrimSuffix(p, ".git")
}

// Clone starts cloning url into parent/<name> (name defaults to the
// repository's) and returns the operation at once. With an opID already
// known it returns that operation and starts nothing (existing is true).
func (s *Service) Clone(opID, rawURL, parent, name string) (Op, bool, error) {
	if opID == "" {
		opID = newOpID()
	}
	if !validOpID.MatchString(opID) {
		return Op{}, false, errors.New("op_id is 1 to 64 letters, digits, - or _")
	}
	s.ops.mu.Lock()
	if o, ok := s.ops.ops[opID]; ok {
		cp := *o
		s.ops.mu.Unlock()
		return cp, true, nil
	}
	s.ops.mu.Unlock()
	if err := CheckCloneURL(rawURL); err != nil {
		return Op{}, false, err
	}
	if name == "" {
		name = repoNameFromURL(rawURL)
	}
	dest, err := newChildDir(parent, name)
	if err != nil {
		return Op{}, false, err
	}
	if _, err := os.Stat(dest); err == nil {
		return Op{}, false, fmt.Errorf("%s already exists; add it instead, or clone under another name", dest)
	}
	now := s.Now().UnixMilli()
	op := &Op{ID: opID, Kind: "clone", State: OpRunning, Phase: "Starting", URL: rawURL, Dest: dest, StartedAt: now, UpdatedAt: now}
	s.ops.mu.Lock()
	if o, ok := s.ops.ops[opID]; ok { // lost a race with the same id
		cp := *o
		s.ops.mu.Unlock()
		return cp, true, nil
	}
	s.ops.ops[opID] = op
	cp := *op
	s.ops.mu.Unlock()
	s.publishOp(cp)
	ctx := s.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	go s.runClone(ctx, opID, rawURL, dest)
	return cp, false, nil
}

func newOpID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// runClone runs `git clone --progress` and turns its progress lines into op
// frames, at most four a second.
func (s *Service) runClone(ctx context.Context, opID, rawURL, dest string) {
	cmd := exec.CommandContext(ctx, gitBin, "clone", "--progress", "--", rawURL, dest) //nolint:gosec // URL checked by CheckCloneURL, after --
	env := os.Environ()
	if s.Env != nil {
		env = s.Env()
	}
	env = append(env, "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	cmd.Env = env
	cmd.Dir = filepath.Dir(dest)
	cmd.WaitDelay = 5 * time.Second
	stderr, err := cmd.StderrPipe()
	if err != nil {
		s.finishOp(opID, 0, err)
		return
	}
	if err := cmd.Start(); err != nil {
		s.finishOp(opID, 0, err)
		return
	}
	var tail []string
	last := time.Time{}
	sc := bufio.NewScanner(stderr)
	sc.Split(splitCRLF)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if phase, pct, ok := parseProgress(line); ok {
			if time.Since(last) < 250*time.Millisecond && pct < 100 {
				continue
			}
			last = time.Now()
			s.updateOp(opID, phase, pct)
			continue
		}
		tail = append(tail, line)
		if len(tail) > 5 {
			tail = tail[1:]
		}
	}
	_, _ = io.Copy(io.Discard, stderr)
	if err := cmd.Wait(); err != nil {
		msg := strings.Join(tail, "\n")
		if msg == "" {
			msg = err.Error()
		}
		s.finishOp(opID, 0, errors.New(msg))
		return
	}
	v, _, err := s.insert(ctx, dest, store.ProjectKindRepo, store.ProjectSourceClone)
	s.finishOp(opID, v.ID, err)
}

// progressLine is git's "Receiving objects:  45% (450/1000), 1.2 MiB | …".
var progressLine = regexp.MustCompile(`^(?:remote: )?([A-Za-z][A-Za-z ]+):\s+(\d{1,3})%`)

func parseProgress(line string) (string, int, bool) {
	m := progressLine.FindStringSubmatch(line)
	if m == nil {
		return "", 0, false
	}
	pct, err := strconv.Atoi(m[2])
	if err != nil || pct > 100 {
		return "", 0, false
	}
	return m[1], pct, true
}

// splitCRLF splits on \r or \n: git redraws a progress line with \r.
func splitCRLF(data []byte, atEOF bool) (int, []byte, error) {
	if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
		return i + 1, data[:i], nil
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

func (s *Service) updateOp(id, phase string, pct int) {
	s.ops.mu.Lock()
	o, ok := s.ops.ops[id]
	if !ok {
		s.ops.mu.Unlock()
		return
	}
	o.Phase, o.Progress, o.UpdatedAt = phase, pct, s.Now().UnixMilli()
	cp := *o
	s.ops.mu.Unlock()
	s.publishOp(cp)
}

func (s *Service) finishOp(id string, projectID int64, err error) {
	s.ops.mu.Lock()
	o, ok := s.ops.ops[id]
	if !ok {
		s.ops.mu.Unlock()
		return
	}
	o.UpdatedAt = s.Now().UnixMilli()
	if err != nil {
		o.State, o.Error = OpFailed, err.Error()
	} else {
		o.State, o.Phase, o.Progress, o.ProjectID = OpDone, "Done", 100, projectID
	}
	cp := *o
	s.ops.mu.Unlock()
	if err != nil {
		s.Log.Warn("clone failed", "component", "projects", "url", cp.URL, "err", err)
	} else {
		s.Log.Info("cloned a project", "component", "projects", "dest", cp.Dest)
	}
	s.publishOp(cp)
}

func (s *Service) publishOp(o Op) {
	if s.Bus != nil {
		s.Bus.Publish(bus.Frame{Type: FrameOp, Data: o})
	}
}
