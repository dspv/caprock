package projects

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/wtsetup"
)

// Finished copies clean themselves up (.ai/21-app.md § Projects, "Finished
// copies"; contract in 03-contracts.md § Projects and shells).
//
// A copy is finished — a cleanup candidate — when Caprock made it (under
// <root>/.caprock-worktrees), nothing runs in it, it has no uncommitted or
// untracked file, its branch has had work on it, and that work is merged
// into the default branch (git, or the branch's pull request merged on
// GitHub, read from the cache the deck's Branches view keeps) and pushed. The
// main checkout, a copy made by hand and an unmerged branch never are.
//
// Nothing polls. A project is checked when a session in one of its copies
// ends, when a pull request of one of its copies' branches is seen merged,
// when the mode changes, and once a day. In Ask mode (the default) the
// candidates are only listed; Clean up removes exactly those. In Auto mode a
// candidate is removed 24 hours after it became one. Either way the branch is
// kept for 7 days, so Restore can put the copy back; after that a branch
// still at the removed commit and still merged is deleted.

// The cleanup modes (config.json "worktree_cleanup").
const (
	CleanupOff  = "off"
	CleanupAsk  = "ask"
	CleanupAuto = "auto"
)

// CleanupModes lists the modes in the order Settings shows them.
var CleanupModes = []string{CleanupOff, CleanupAsk, CleanupAuto}

// NormalizeCleanup is the effective mode: ask when unset or unknown.
func NormalizeCleanup(m string) string {
	switch m {
	case CleanupOff, CleanupAuto:
		return m
	}
	return CleanupAsk
}

// ValidCleanupMode reports whether m is one of CleanupModes.
func ValidCleanupMode(m string) bool {
	return m == CleanupOff || m == CleanupAsk || m == CleanupAuto
}

// How a copy was removed, as the history says.
const (
	cleanupHowAuto   = "auto"
	cleanupHowAsk    = "ask"
	cleanupManual    = "manual"
	cleanupStateFile = "worktree-cleanup.json"
)

// CleanupStateFile is the state's file name in the data directory.
const CleanupStateFile = cleanupStateFile

// The windows. Variables so a test can shorten them.
var (
	// cleanupGrace is how long a candidate waits in Auto mode.
	cleanupGrace = 24 * time.Hour
	// cleanupKeep is how long a removed copy's branch is kept, and Restore
	// offered.
	cleanupKeep = 7 * 24 * time.Hour
	// cleanupStaleAfter is how long without a commit makes a copy stale.
	cleanupStaleAfter = 14 * 24 * time.Hour
	// cleanupShown is how long "Removed 3 copies · Undo" stays.
	cleanupShown = 24 * time.Hour
	// cleanupHistoryFor and cleanupHistoryMax bound the history.
	cleanupHistoryFor = 30 * 24 * time.Hour
	cleanupHistoryMax = 200
	// cleanupDaily is the daily pass; cleanupFirst the first after start.
	cleanupDaily = 24 * time.Hour
	cleanupFirst = 10 * time.Minute
	// cleanupSettle gathers triggers for one project into one check.
	cleanupSettle = 5 * time.Second
)

// CleanupCandidate is one finished copy.
type CleanupCandidate struct {
	Path       string `json:"path"`
	Branch     string `json:"branch"`
	Size       *int64 `json:"size"` // null while measured
	SizeCapped bool   `json:"size_capped,omitempty"`
	// Since is when it became a candidate, Unix ms; Due, in Auto mode, when
	// it is removed.
	Since int64 `json:"since"`
	Due   int64 `json:"due,omitempty"`
	// PR is the merged pull request that made it one, when git alone did
	// not (a squash merge).
	PR int `json:"pr,omitempty"`
}

// CleanupRecord is one removed copy in the history.
type CleanupRecord struct {
	ID        string `json:"id"`
	ProjectID int64  `json:"project_id"`
	Path      string `json:"path"`
	Branch    string `json:"branch,omitempty"`
	Head      string `json:"head,omitempty"`
	Bytes     int64  `json:"bytes"`
	At        int64  `json:"at"`  // Unix ms
	How       string `json:"how"` // auto | ask | manual
	// BranchDeleted: the branch went with it (asked for, manual) or after
	// the 7 days.
	BranchDeleted bool  `json:"branch_deleted,omitempty"`
	RestoredAt    int64 `json:"restored_at,omitempty"`
	// Settled: the 7 days are over and the branch was dealt with.
	Settled bool `json:"settled,omitempty"`
	// Restorable is worked out on read: within 7 days, not restored, the
	// folder free.
	Restorable bool `json:"restorable"`
}

// CleanupView is GET /v1/projects/{id}/cleanup.
type CleanupView struct {
	Mode       string             `json:"mode"`
	Candidates []CleanupCandidate `json:"candidates"`
	Total      int64              `json:"total"`
	Pending    bool               `json:"pending,omitempty"`
	// Removed are the copies cleaned up (Ask or Auto, not the copies
	// sheet) in the last day and not restored: the "Removed 3 copies ·
	// Undo" line.
	Removed []CleanupRecord `json:"removed"`
	// History is this project's removals, newest first.
	History   []CleanupRecord `json:"history"`
	CheckedAt int64           `json:"checked_at"`
}

// CleanupRestored is what Restore did with one record.
type CleanupRestored struct {
	ID       string `json:"id"`
	Path     string `json:"path,omitempty"`
	Restored bool   `json:"restored"`
	Error    string `json:"error,omitempty"`
}

// cleanupFile is what is kept on disk.
type cleanupFile struct {
	// Since is when each candidate (by path key) became one.
	Since map[string]int64 `json:"since"`
	// Kept are restored copies (path key → the commit restored): not a
	// candidate again until their HEAD moves.
	Kept    map[string]string `json:"kept,omitempty"`
	Removed []CleanupRecord   `json:"removed"`
}

type cleanupState struct {
	check sync.Mutex // one check at a time

	mu      sync.Mutex
	loaded  bool
	file    cleanupFile
	cands   map[int64][]CleanupCandidate
	checked map[int64]int64
	timers  map[int64]*time.Timer
	daily   *time.Timer
	stopped bool
}

func (s *Service) cleaner() *cleanupState {
	s.cleanOnce.Do(func() {
		s.clean = &cleanupState{cands: map[int64][]CleanupCandidate{}, checked: map[int64]int64{}, timers: map[int64]*time.Timer{}}
	})
	c := s.clean
	c.mu.Lock()
	if !c.loaded {
		c.loaded = true
		c.file = cleanupFile{Since: map[string]int64{}, Kept: map[string]string{}}
		if s.CleanupFile != "" {
			if b, err := os.ReadFile(s.CleanupFile); err == nil {
				var f cleanupFile
				if json.Unmarshal(b, &f) == nil {
					c.file = f
				}
			}
		}
		if c.file.Since == nil {
			c.file.Since = map[string]int64{}
		}
		if c.file.Kept == nil {
			c.file.Kept = map[string]string{}
		}
	}
	c.mu.Unlock()
	return c
}

// saveLocked writes the state; c.mu is held.
func (s *Service) saveCleanupLocked(c *cleanupState) {
	if s.CleanupFile == "" {
		return
	}
	b, err := json.MarshalIndent(c.file, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.CleanupFile), 0o700); err != nil {
		return
	}
	if err := config.WriteFileAtomic(s.CleanupFile, b, 0o600); err != nil {
		s.Log.Warn("could not save the copies' cleanup state", "component", "projects", "err", err)
	}
}

func (s *Service) cleanupMode() string {
	if s.CleanupMode == nil {
		return CleanupAsk
	}
	return NormalizeCleanup(s.CleanupMode())
}

func (s *Service) busyFunc(ctx context.Context) BusyFunc {
	if s.Busy == nil {
		return nil
	}
	return s.Busy(ctx)
}

// remoteURL is the project's origin as its last git answer gave it.
func (s *Service) remoteURL(id int64) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if g := s.git[id]; g != nil {
		return g.status.RemoteURL
	}
	return ""
}

// prOf is the cached pull request of a branch, "" when none is known.
func (s *Service) prOf(id int64, branch string) (string, int, string) {
	if s.PRState == nil || branch == "" {
		return "", 0, ""
	}
	u := s.remoteURL(id)
	if u == "" {
		return "", 0, ""
	}
	return s.PRState(u, branch)
}

// isStale: a copy Caprock made, no commit for 14 days, no pull request known.
func (s *Service) isStale(id int64, c Copy) bool {
	if c.Main || !c.Caprock || c.CommittedAt == 0 {
		return false
	}
	if s.Now().Sub(time.Unix(c.CommittedAt, 0)) < cleanupStaleAfter {
		return false
	}
	state, _, _ := s.prOf(id, c.Branch)
	return state == ""
}

// branchWorked reports whether a branch had anything done on it after it was
// made: its reflog has more than the "Created from" entry. A fresh copy no
// agent has committed in is merged trivially and is not finished. Unknown
// (no reflog) counts as worked.
func (s *Service) branchWorked(ctx context.Context, root, branch string) bool {
	out, err := runGit(ctx, s.GitTimeout, root, "reflog", "show", "--format=%H", "refs/heads/"+branch, "--")
	if err != nil {
		return true
	}
	n := 0
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.TrimSpace(l) != "" {
			n++
		}
	}
	return n != 1
}

// candidate judges one copy; pr is the merged pull request that decided it.
func (s *Service) candidate(ctx context.Context, id int64, r copiesRepo, c Copy, hasRemote bool, kept map[string]string) (ok bool, pr int) {
	if c.Main || !c.Caprock || c.Missing || c.Locked || len(c.Live) > 0 || c.Dirty || c.Changed > 0 ||
		c.Error != "" || c.Detached || c.Branch == "" || c.Branch == r.defaultBranch || c.Orphaned > 0 {
		return false, 0
	}
	if h, ok := kept[cleanKey(c.Path)]; ok && h == c.Head {
		return false, 0
	}
	state, num, head := s.prOf(id, c.Branch)
	prMerged := state == "merged" && (head == "" || head == c.Head)
	if !c.Merged && !prMerged {
		return false, 0
	}
	if hasRemote && c.Unpushed > 0 && (!prMerged || head != c.Head) {
		return false, 0
	}
	if !prMerged && !s.branchWorked(ctx, r.root, c.Branch) {
		return false, 0
	}
	if prMerged && !c.Merged {
		return true, num
	}
	return true, 0
}

// CheckCleanup works out a project's finished copies now, and in Auto mode
// removes those whose 24 hours are up.
func (s *Service) CheckCleanup(ctx context.Context, id int64) error {
	c := s.cleaner()
	c.check.Lock()
	defer c.check.Unlock()
	return s.checkLocked(ctx, id)
}

func (s *Service) checkLocked(ctx context.Context, id int64) error {
	if s.closed.Load() {
		return errors.New("shutting down")
	}
	if s.cleanupMode() == CleanupOff {
		c := s.cleaner()
		c.mu.Lock()
		delete(c.cands, id)
		c.checked[id] = s.Now().UnixMilli()
		c.mu.Unlock()
		return nil
	}
	r, err := s.copiesRepo(ctx, id)
	if err != nil {
		return err
	}
	busy := s.busyFunc(ctx)
	cands, err := s.findCandidates(ctx, id, r, busy)
	if err != nil || s.cleanupMode() != CleanupAuto {
		return err
	}
	now := s.Now().UnixMilli()
	var due []CleanupCandidate
	next := int64(0)
	for _, cd := range cands {
		if cd.Due <= now {
			due = append(due, cd)
		} else if next == 0 || cd.Due < next {
			next = cd.Due
		}
	}
	if len(due) > 0 {
		s.removeCandidates(ctx, id, r, due, cleanupHowAuto, busy)
		s.refreshNow(id)
		_, err = s.findCandidates(ctx, id, r, busy)
	}
	if next > 0 {
		s.scheduleCleanup(id, time.Until(time.UnixMilli(next))+time.Second)
	}
	return err
}

// findCandidates lists a project's finished copies, notes when each became
// one, forgets those that stopped being one, and keeps the answer for GET.
func (s *Service) findCandidates(ctx context.Context, id int64, r copiesRepo, busy BusyFunc) ([]CleanupCandidate, error) {
	c := s.cleaner()
	v, err := s.copiesOf(ctx, id, r, busy)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	kept := cloneMap(c.file.Kept)
	c.mu.Unlock()
	var cands []CleanupCandidate
	for _, cp := range v.Copies {
		if ok, pr := s.candidate(ctx, id, r, cp, v.HasRemote, kept); ok {
			cands = append(cands, CleanupCandidate{Path: cp.Path, Branch: cp.Branch, PR: pr})
		}
	}
	auto := s.cleanupMode() == CleanupAuto
	under := cleanKey(filepath.Join(r.root, agents.WorktreeDir)) + string(filepath.Separator)
	heads := map[string]string{}
	for _, cp := range v.Copies {
		heads[cleanKey(cp.Path)] = cp.Head
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := s.Now().UnixMilli()
	seen := map[string]bool{}
	for i := range cands {
		k := cleanKey(cands[i].Path)
		seen[k] = true
		since, ok := c.file.Since[k]
		if !ok {
			since = now
			c.file.Since[k] = since
		}
		cands[i].Since = since
		if auto {
			cands[i].Due = since + cleanupGrace.Milliseconds()
		}
	}
	for k := range c.file.Since {
		if strings.HasPrefix(k, under) && !seen[k] {
			delete(c.file.Since, k)
		}
	}
	// A kept copy that is gone, or whose HEAD moved, is kept no more.
	for k, h := range c.file.Kept {
		if strings.HasPrefix(k, under) && heads[k] != h {
			delete(c.file.Kept, k)
		}
	}
	c.cands[id] = cands
	c.checked[id] = now
	s.saveCleanupLocked(c)
	return cands, nil
}

func cloneMap(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// removeCandidates removes copies, each judged again by removeCopy (never
// forced, the branch never deleted), and records them.
func (s *Service) removeCandidates(ctx context.Context, id int64, r copiesRepo, list []CleanupCandidate, how string, busy BusyFunc) []CopyRemoved {
	out := make([]CopyRemoved, 0, len(list))
	for _, cd := range list {
		res := CopyRemoved{Path: cd.Path}
		gone, err := s.removeCopy(ctx, r, CopyRemoval{Path: cd.Path}, false, busy, &res)
		if err != nil {
			res.Error = err.Error()
			res.Confirm = errors.Is(err, ErrCopyNeedsConfirm)
		}
		if res.Removed {
			s.recordRemoval(id, gone, how, false)
			s.Log.Info("removed a finished copy", "component", "projects", "path", cd.Path, "branch", cd.Branch, "how", how)
		}
		out = append(out, res)
	}
	return out
}

// recordRemoval adds a removal to the history.
func (s *Service) recordRemoval(id int64, gone removedCopy, how string, branchDeleted bool) {
	c := s.cleaner()
	var b [6]byte
	_, _ = rand.Read(b[:])
	rec := CleanupRecord{
		ID: hex.EncodeToString(b[:]), ProjectID: id, Path: gone.copy.Path, Branch: gone.copy.Branch, Head: gone.copy.Head,
		Bytes: gone.bytes, At: s.Now().UnixMilli(), How: how, BranchDeleted: branchDeleted,
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.file.Since, cleanKey(gone.copy.Path))
	delete(c.file.Kept, cleanKey(gone.copy.Path))
	c.file.Removed = append(c.file.Removed, rec)
	s.pruneHistoryLocked(c)
	s.saveCleanupLocked(c)
}

// pruneHistoryLocked drops records past 30 days, then the oldest past 200.
func (s *Service) pruneHistoryLocked(c *cleanupState) {
	cut := s.Now().Add(-cleanupHistoryFor).UnixMilli()
	out := c.file.Removed[:0]
	for _, r := range c.file.Removed {
		// One still within its 7 days is kept whatever its age says.
		if r.At >= cut || !r.Settled && r.RestoredAt == 0 && !r.BranchDeleted && r.How != cleanupManual {
			out = append(out, r)
		}
	}
	if len(out) > cleanupHistoryMax {
		out = out[len(out)-cleanupHistoryMax:]
	}
	c.file.Removed = out
}

// Cleanup is a project's finished copies and its removal history. The first
// ask after a start checks the project; later ones answer from the last
// check, with sizes from the size cache.
func (s *Service) Cleanup(ctx context.Context, id int64) (CleanupView, error) {
	c := s.cleaner()
	c.mu.Lock()
	_, ok := c.checked[id]
	c.mu.Unlock()
	if !ok {
		if _, err := s.copiesRepo(ctx, id); err != nil {
			return CleanupView{}, err
		}
		if err := s.CheckCleanup(ctx, id); err != nil {
			s.Log.Debug("copies' cleanup check", "component", "projects", "id", id, "err", err)
		}
	}
	now := s.Now()
	v := CleanupView{Mode: s.cleanupMode(), Candidates: []CleanupCandidate{}, Removed: []CleanupRecord{}, History: []CleanupRecord{}}
	c.mu.Lock()
	cands := append([]CleanupCandidate(nil), c.cands[id]...)
	v.CheckedAt = c.checked[id]
	recs := append([]CleanupRecord(nil), c.file.Removed...)
	c.mu.Unlock()
	if v.Mode != CleanupOff {
		for _, cd := range cands {
			size, capped, known := s.sizes().get(s, cd.Path)
			if known {
				cd.Size, cd.SizeCapped = &size, capped
				v.Total += size
			} else {
				v.Pending = true
			}
			v.Candidates = append(v.Candidates, cd)
		}
	}
	for i := len(recs) - 1; i >= 0; i-- {
		r := recs[i]
		if r.ProjectID != id {
			continue
		}
		r.Restorable = r.RestoredAt == 0 && now.Sub(time.UnixMilli(r.At)) < cleanupKeep && !exists(r.Path)
		if r.How != cleanupManual && r.RestoredAt == 0 && now.Sub(time.UnixMilli(r.At)) < cleanupShown {
			v.Removed = append(v.Removed, r)
		}
		if len(v.History) < 20 {
			v.History = append(v.History, r)
		}
	}
	return v, nil
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// CleanUp removes exactly the listed copies of the ones last found
// finished, after judging them again now ("Clean up" in Ask mode, and
// "Clean up now" in Auto mode). A path that is no longer finished is kept,
// with the reason.
func (s *Service) CleanUp(ctx context.Context, id int64, paths []string) ([]CopyRemoved, error) {
	c := s.cleaner()
	c.check.Lock()
	defer c.check.Unlock()
	if s.cleanupMode() == CleanupOff {
		return nil, errors.New("cleaning up finished copies is off (Settings → Projects)")
	}
	r, err := s.copiesRepo(ctx, id)
	if err != nil {
		return nil, err
	}
	busy := s.busyFunc(ctx)
	cands, err := s.findCandidates(ctx, id, r, busy)
	if err != nil {
		return nil, err
	}
	finished := map[string]CleanupCandidate{}
	for _, cd := range cands {
		finished[cleanKey(cd.Path)] = cd
	}
	var list []CleanupCandidate
	var out []CopyRemoved
	for _, p := range paths {
		p = filepath.Clean(filepath.FromSlash(strings.TrimSpace(p)))
		cd, ok := finished[cleanKey(p)]
		if !ok {
			out = append(out, CopyRemoved{Path: p, Error: "not finished any more: something runs in it, it has changes, or its branch is not merged and pushed"})
			continue
		}
		list = append(list, cd)
	}
	out = append(out, s.removeCandidates(ctx, id, r, list, cleanupHowAsk, busy)...)
	s.refreshNow(id)
	_, _ = s.findCandidates(ctx, id, r, busy)
	return out, nil
}

// Restore puts removed copies back from their kept branches (Undo, and
// Restore in the copies sheet): `git worktree add <path> <branch>`, or, if
// the branch is gone, `git worktree add -b <branch> <path> <commit>`. A
// restored copy is not a candidate again until its HEAD moves.
func (s *Service) Restore(ctx context.Context, id int64, ids []string) ([]CleanupRestored, error) {
	c := s.cleaner()
	c.check.Lock()
	defer c.check.Unlock()
	r, err := s.copiesRepo(ctx, id)
	if err != nil {
		return nil, err
	}
	out := make([]CleanupRestored, 0, len(ids))
	restored := false
	for _, rid := range ids {
		res := CleanupRestored{ID: rid}
		if err := s.restoreOne(ctx, id, r, rid, &res); err != nil {
			res.Error = err.Error()
		} else {
			restored = true
		}
		out = append(out, res)
	}
	if restored {
		s.refreshNow(id)
		_, _ = s.findCandidates(ctx, id, r, s.busyFunc(ctx))
	}
	return out, nil
}

func (s *Service) restoreOne(ctx context.Context, id int64, r copiesRepo, rid string, res *CleanupRestored) error {
	c := s.cleaner()
	c.mu.Lock()
	idx := -1
	for i := range c.file.Removed {
		if c.file.Removed[i].ID == rid && c.file.Removed[i].ProjectID == id {
			idx = i
		}
	}
	var rec CleanupRecord
	if idx >= 0 {
		rec = c.file.Removed[idx]
	}
	c.mu.Unlock()
	if idx < 0 {
		return errors.New("no such removal in this project's history")
	}
	res.Path = rec.Path
	switch {
	case rec.RestoredAt != 0:
		return errors.New("already restored")
	case s.Now().Sub(time.UnixMilli(rec.At)) >= cleanupKeep:
		return errors.New("removed more than 7 days ago; its branch is no longer kept")
	case !sameFolder(filepath.Dir(rec.Path), filepath.Join(r.root, agents.WorktreeDir)):
		return errors.New("not a copy Caprock made")
	case exists(rec.Path):
		return fmt.Errorf("%s exists again; move it aside first", rec.Path)
	}
	head := rec.Head
	if rec.Branch != "" {
		if _, err := runGit(ctx, s.GitTimeout, r.root, "rev-parse", "--verify", "--quiet", "refs/heads/"+rec.Branch); err == nil {
			if _, err := runGit(ctx, time.Minute, r.root, "worktree", "add", rec.Path, rec.Branch); err != nil {
				return err
			}
			head = ""
		}
	}
	if head != "" {
		if _, err := runGit(ctx, s.GitTimeout, r.root, "cat-file", "-e", head+"^{commit}"); err != nil {
			return errors.New("its branch and commit are both gone")
		}
		args := []string{"worktree", "add"}
		if rec.Branch != "" {
			args = append(args, "-b", rec.Branch)
		} else {
			args = append(args, "--detach")
		}
		if _, err := runGit(ctx, time.Minute, r.root, append(args, rec.Path, head)...); err != nil {
			return err
		}
	}
	// The git-ignored files .worktreeinclude lists come back as on a new
	// copy; a failure here is the copy's extras, not the copy.
	_, _ = wtsetup.CopyIncluded(ctx, r.root, rec.Path)
	res.Restored = true
	now := s.Now().UnixMilli()
	c.mu.Lock()
	for i := range c.file.Removed {
		if c.file.Removed[i].ID == rid {
			c.file.Removed[i].RestoredAt = now
		}
	}
	h := rec.Head
	if out, err := runGit(ctx, s.GitTimeout, rec.Path, "rev-parse", "HEAD"); err == nil {
		h = strings.TrimSpace(string(out))
	}
	c.file.Kept[cleanKey(rec.Path)] = h
	delete(c.file.Since, cleanKey(rec.Path))
	s.saveCleanupLocked(c)
	c.mu.Unlock()
	return nil
}

// ── Triggers ─────────────────────────────────────────────────────────────

// scheduleCleanup checks a project after a delay, once for a burst.
func (s *Service) scheduleCleanup(id int64, after time.Duration) {
	if s.closed.Load() {
		return
	}
	if after < cleanupSettle {
		after = cleanupSettle
	}
	c := s.cleaner()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped {
		return
	}
	if t := c.timers[id]; t != nil {
		t.Stop()
	}
	c.timers[id] = time.AfterFunc(after, func() {
		c.mu.Lock()
		delete(c.timers, id)
		c.mu.Unlock()
		ctx := s.ctx
		if ctx == nil {
			ctx = context.Background()
		}
		if err := s.CheckCleanup(ctx, id); err != nil && !s.closed.Load() {
			s.Log.Debug("copies' cleanup check", "component", "projects", "id", id, "err", err)
		}
	})
}

// CleanupSoon checks a project shortly: a session in one of its copies ended.
func (s *Service) CleanupSoon(id int64) { s.scheduleCleanup(id, cleanupSettle) }

// CleanupBranchesMerged is told the branches whose pull requests were just
// seen merged; each project with a copy of Caprock's on one is checked.
func (s *Service) CleanupBranchesMerged(branches []string) {
	if len(branches) == 0 || s.cleanupMode() == CleanupOff {
		return
	}
	want := map[string]bool{}
	for _, b := range branches {
		want[b] = true
	}
	for _, id := range s.projectsWithCopies(func(w WorktreeView) bool { return want[w.Branch] }) {
		s.CleanupSoon(id)
	}
}

// CleanupModeChanged checks every project with copies again.
func (s *Service) CleanupModeChanged() {
	for _, id := range s.projectsWithCopies(nil) {
		s.CleanupSoon(id)
	}
}

// projectsWithCopies lists the projects with a copy Caprock made (matching
// match, when given), from the git state already held: no git runs.
func (s *Service) projectsWithCopies(match func(WorktreeView) bool) []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var ids []int64
	for id, g := range s.git {
		for _, w := range g.worktrees {
			if w.Caprock && (match == nil || match(w)) {
				ids = append(ids, id)
				break
			}
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// inCopy reports whether a session's folder is inside a copy Caprock made.
func inCopy(dir string) bool {
	d := strings.ReplaceAll(dir, `\`, "/")
	return strings.Contains(d+"/", "/"+agents.WorktreeDir+"/")
}

func (s *Service) startCleanup() {
	c := s.cleaner()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopped = false
	c.daily = time.AfterFunc(cleanupFirst, s.dailyCleanup)
}

func (s *Service) stopCleanup() {
	if s.clean == nil {
		return
	}
	c := s.clean
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopped = true
	if c.daily != nil {
		c.daily.Stop()
	}
	for id, t := range c.timers {
		t.Stop()
		delete(c.timers, id)
	}
}

// dailyCleanup is the once-a-day pass: each project with copies is checked,
// and the branches of copies removed 7 days ago are dealt with.
func (s *Service) dailyCleanup() {
	if s.closed.Load() {
		return
	}
	ctx := s.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	if s.cleanupMode() != CleanupOff {
		for _, id := range s.projectsWithCopies(nil) {
			if s.closed.Load() {
				return
			}
			_ = s.CheckCleanup(ctx, id)
		}
		s.settleBranches(ctx)
	}
	c := s.cleaner()
	c.mu.Lock()
	defer c.mu.Unlock()
	s.pruneHistoryLocked(c)
	s.saveCleanupLocked(c)
	if !c.stopped && !s.closed.Load() {
		c.daily = time.AfterFunc(cleanupDaily, s.dailyCleanup)
	}
}

// settleBranches deletes the branch of each copy cleaned up (Ask or Auto)
// more than 7 days ago and not restored, when the branch still points at the
// removed commit, no copy has it checked out, and it is still merged (or its
// pull request is). Any other branch is left alone for good. A branch the
// person removed by hand in the copies sheet is never touched.
func (s *Service) settleBranches(ctx context.Context) {
	c := s.cleaner()
	c.check.Lock()
	defer c.check.Unlock()
	now := s.Now()
	c.mu.Lock()
	var due []CleanupRecord
	for _, r := range c.file.Removed {
		if !r.Settled && r.RestoredAt == 0 && r.How != cleanupManual && now.Sub(time.UnixMilli(r.At)) >= cleanupKeep {
			due = append(due, r)
		}
	}
	c.mu.Unlock()
	for _, rec := range due {
		deleted := s.settleBranch(ctx, rec)
		c.mu.Lock()
		for i := range c.file.Removed {
			if c.file.Removed[i].ID == rec.ID {
				c.file.Removed[i].Settled = true
				c.file.Removed[i].BranchDeleted = c.file.Removed[i].BranchDeleted || deleted
			}
		}
		c.mu.Unlock()
	}
	c.mu.Lock()
	s.saveCleanupLocked(c)
	c.mu.Unlock()
}

func (s *Service) settleBranch(ctx context.Context, rec CleanupRecord) bool {
	if rec.Branch == "" || rec.BranchDeleted {
		return false
	}
	r, err := s.copiesRepo(ctx, rec.ProjectID)
	if err != nil || rec.Branch == r.defaultBranch {
		return false
	}
	out, err := runGit(ctx, s.GitTimeout, r.root, "rev-parse", "--verify", "--quiet", "refs/heads/"+rec.Branch)
	if err != nil || strings.TrimSpace(string(out)) != rec.Head {
		return false
	}
	entries, err := s.listPorcelain(ctx, r)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.Branch == rec.Branch {
			return false
		}
	}
	state, _, head := s.prOf(rec.ProjectID, rec.Branch)
	if !s.mergedInto(ctx, r.root, "refs/heads/"+rec.Branch, r.defaultRefs) && (state != "merged" || head != rec.Head) {
		return false
	}
	if _, err := runGit(ctx, s.GitTimeout, r.root, "branch", "-D", rec.Branch); err != nil {
		return false
	}
	s.Log.Info("deleted the branch of a copy cleaned up a week ago", "component", "projects", "branch", rec.Branch)
	return true
}
