package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/projects"
	"github.com/dspv/caprock/internal/store"
)

// Projects, worktrees and shell tabs (.ai/21-app.md § Projects and § Shell
// tabs; contract in 03-contracts.md § Projects and shells).
//
// A controller phone may add, create and clone a project under home, change
// or unlist one, and create or remove a worktree in one under home (ADR-034,
// amended for WP-05/WP-08). Shells are the machine's for now: the owner put
// them at P1 for the phone (21-app.md decision 8), so every shell route, and
// the terminal of a shell, is refused to a device.

// ShellInfo is a running shell tab.
type ShellInfo struct {
	ID              string `json:"id"`
	Cwd             string `json:"cwd"`
	Command         string `json:"command"`
	StartedAt       int64  `json:"started_at"`
	SurvivesRestart bool   `json:"survives_restart"`
	ProjectID       int64  `json:"project_id,omitempty"`
	// Program is what runs in front of the shell's prompt ("claude", "npm",
	// "vim"); absent when the shell is idle or the platform cannot tell.
	// Closing the tab of an idle shell ends it; a busy one asks first.
	Program string `json:"program,omitempty"`
	// Internal is always true: a shell is not a session and is in no total.
	Internal bool   `json:"internal"`
	Kind     string `json:"kind"` // "shell"
}

// ShellController starts and lists shell tabs. The terminal itself is the
// agent's: /v1/agents/{id}/term, input, signal and resize.
type ShellController interface {
	StartShell(ctx context.Context, cwd string, cols, rows int) (ShellInfo, error)
	Shells() []ShellInfo
	IsShell(id string) bool
}

func (s *Server) requireProjects(w http.ResponseWriter) bool {
	if s.d.Projects == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "projects are unavailable"})
		return false
	}
	return true
}

// projectErr answers a projects error: 404 for an unknown id, else 400 with
// the reason as git or the check said it.
func projectErr(w http.ResponseWriter, err error) {
	code := http.StatusBadRequest
	if errors.Is(err, store.ErrProjectNotFound) {
		code = http.StatusNotFound
	}
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

func pathID(r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return id, err == nil && id > 0
}

func (s *Server) handleProjects(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	list, err := s.d.Projects.List(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": list})
}

// handleTeamSignal is GET /v1/team-signal: how many distinct people committed
// to the listed repositories in the last 30 days. Counts only — the Caprock
// for Teams card shows when the answer is two or more (see .ai/04-ui.md,
// "Product-led surfaces"). Cached for hours in the projects service, so a
// polled screen does not start a process on every load.
func (s *Server) handleTeamSignal(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	sig, err := s.d.Projects.TeamSignal(r.Context(), 30)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sig)
}

// addProjectRequest is POST /v1/projects: exactly one of path, create, clone.
type addProjectRequest struct {
	Path string `json:"path,omitempty"`
	// Repos, with path, lists path as one multi-repo project of these
	// repositories (ADR-055).
	Repos  []string `json:"repos,omitempty"`
	Create *struct {
		Parent  string `json:"parent"`
		Name    string `json:"name"`
		GitInit bool   `json:"git_init"`
	} `json:"create,omitempty"`
	Clone *struct {
		URL    string `json:"url"`
		Parent string `json:"parent"`
		Name   string `json:"name,omitempty"`
	} `json:"clone,omitempty"`
	OpID string `json:"op_id,omitempty"`
}

func (s *Server) handleAddProject(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	var req addProjectRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	n := 0
	for _, set := range []bool{req.Path != "", req.Create != nil, req.Clone != nil} {
		if set {
			n++
		}
	}
	if n != 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `send one of {"path"}, {"create":{parent,name,git_init}} or {"clone":{url,parent}}`})
		return
	}
	if phoneLimited(r) {
		dir := req.Path
		switch {
		case req.Create != nil:
			dir = req.Create.Parent
		case req.Clone != nil:
			dir = req.Clone.Parent
		}
		if !filepath.IsAbs(dir) || !underHome(filepath.Clean(dir), false) || !allUnderHome(req.Repos) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "a phone adds, creates and clones projects in folders under your home directory"})
			return
		}
		// Narrower than the machine's user@host:path: a phone clones what a
		// hosting service hands out, https:// or git@ (WP-15).
		if req.Clone != nil && !strings.HasPrefix(req.Clone.URL, "https://") && !strings.HasPrefix(req.Clone.URL, "git@") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a phone clones an https:// or git@host:owner/repo address"})
			return
		}
	}
	ctx := context.WithoutCancel(r.Context())
	if len(req.Repos) > 0 && req.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `repos goes with {"path"}: the folder that holds them`})
		return
	}
	switch {
	case req.Path != "" && len(req.Repos) > 0:
		v, created, err := s.d.Projects.AddMulti(ctx, filepath.Clean(req.Path), req.Repos)
		if err != nil {
			projectErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"project": v, "created": created})
	case req.Path != "":
		v, created, err := s.d.Projects.Add(ctx, filepath.Clean(req.Path))
		if err != nil {
			projectErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"project": v, "created": created})
	case req.Create != nil:
		v, err := s.d.Projects.Create(ctx, filepath.Clean(req.Create.Parent), req.Create.Name, req.Create.GitInit)
		if err != nil {
			projectErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"project": v, "created": true})
	default:
		op, existing, err := s.d.Projects.Clone(req.OpID, req.Clone.URL, filepath.Clean(req.Clone.Parent), req.Clone.Name)
		if err != nil {
			projectErr(w, err)
			return
		}
		if dev := deviceFrom(r); dev != nil && !existing {
			s.d.Log.Info("clone started from a paired device", "component", "api", "op", op.ID, "device", dev.ID, "device_name", dev.Name)
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"op": op, "existing": existing})
	}
}

func (s *Server) handleProjectOps(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ops": s.d.Projects.Ops()})
}

func (s *Server) handlePatchProject(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such project"})
		return
	}
	var p projects.Patch
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&p); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body is {name?, pinned?, sort?, defaults?, repos?}"})
		return
	}
	if p.Repos != nil && phoneLimited(r) && !allUnderHome(*p.Repos) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "a phone adds repositories under your home directory"})
		return
	}
	// A setup command is a command this machine will run (ADR-050). A
	// controller may start agents, but not decide what runs before them:
	// that is set on the machine, like a shell (ADR-034). A computer
	// (ADR-067) starts any command anyway, so it may set one.
	if p.Defaults != nil && phoneLimited(r) {
		cur, _ := s.d.Projects.Project(id)
		if strings.TrimSpace(projects.SetupCommandOf(string(*p.Defaults))) != projects.SetupCommandOf(cur.Defaults) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "a project's setup command is set on the computer Caprock runs on"})
			return
		}
	}
	v, err := s.d.Projects.Update(r.Context(), id, p)
	if err != nil {
		projectErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"project": v})
}

// handleUnlistProject takes a project off the list. It never deletes a file.
func (s *Server) handleUnlistProject(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such project"})
		return
	}
	if err := s.d.Projects.Unlist(r.Context(), id); err != nil {
		projectErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleWorktrees(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such project"})
		return
	}
	wts, err := s.d.Projects.Worktrees(r.Context(), id)
	if err != nil {
		projectErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"worktrees": wts})
}

// handleBranches lists a project's branches for New agent's *New copy from*:
// main branches first, then by newest commit (agents.ListBranches).
func (s *Server) handleBranches(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such project"})
		return
	}
	if !s.deviceMayTouchProject(w, r, id) {
		return
	}
	v, err := s.d.Projects.Get(r.Context(), id)
	if err != nil {
		projectErr(w, err)
		return
	}
	list, err := agents.ListBranches(r.Context(), v.Root)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"branches": []agents.Branch{}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"branches": list})
}

// deviceMayTouchProject refuses a device a project whose folder is outside
// home, and says so. True when the request may go on.
func (s *Server) deviceMayTouchProject(w http.ResponseWriter, r *http.Request, id int64) bool {
	if !phoneLimited(r) {
		return true
	}
	v, err := s.d.Projects.Get(r.Context(), id)
	if err != nil {
		projectErr(w, err)
		return false
	}
	if !underHome(filepath.Clean(v.Root), false) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "a phone works on worktrees of projects under your home directory"})
		return false
	}
	return true
}

func (s *Server) handleAddWorktree(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such project"})
		return
	}
	var body struct {
		Branch string `json:"branch"`
		Create bool   `json:"create,omitempty"`
		Base   string `json:"base,omitempty"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body is {branch, create?, base?}"})
		return
	}
	if !s.deviceMayTouchProject(w, r, id) {
		return
	}
	wt, err := s.d.Projects.AddWorktree(context.WithoutCancel(r.Context()), id, agents.WorktreeSpec{Branch: body.Branch, Create: body.Create, Base: body.Base})
	if err != nil {
		projectErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"worktree": wt})
}

func (s *Server) handleRemoveWorktree(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such project"})
		return
	}
	if !s.deviceMayTouchProject(w, r, id) {
		return
	}
	err := s.d.Projects.RemoveWorktree(context.WithoutCancel(r.Context()), id, r.PathValue("name"))
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, agents.ErrWorktreeDirty):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	default:
		projectErr(w, err)
	}
}

// handleStartShell starts a login shell in a folder or a project.
func (s *Server) handleStartShell(w http.ResponseWriter, r *http.Request) {
	if s.d.Shells == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "shells are unavailable"})
		return
	}
	var body struct {
		Cwd       string `json:"cwd,omitempty"`
		ProjectID int64  `json:"project_id,omitempty"`
		Cols      int    `json:"cols,omitempty"`
		Rows      int    `json:"rows,omitempty"`
		// Replaces is the session whose program exited and whose tab this
		// shell takes over. Every client showing that tab asks; one shell
		// answers them all.
		Replaces string `json:"replaces,omitempty"`
		// Type is one line typed at the new shell's prompt once it is drawn,
		// never followed by Enter: an agent's install or sign-in command the
		// user reads and runs (ADR-046).
		Type string `json:"type,omitempty"`
		// Run presses Enter after Type: a saved command the user picked to
		// run (ADR-051). Still one line.
		Run bool `json:"run,omitempty"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body is {cwd | project_id, cols?, rows?, replaces?, type?, run?}"})
		return
	}
	cwd := body.Cwd
	if cwd == "" && body.ProjectID > 0 && s.d.Projects != nil {
		v, err := s.d.Projects.Get(r.Context(), body.ProjectID)
		if err != nil {
			projectErr(w, err)
			return
		}
		cwd = v.Root
	}
	if cwd == "" || !filepath.IsAbs(cwd) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name a folder (cwd) or a project (project_id)"})
		return
	}
	if body.Replaces != "" {
		s.replMu.Lock()
		defer s.replMu.Unlock()
		if sh, ok := s.replacement(body.Replaces); ok {
			writeJSON(w, http.StatusOK, map[string]any{"shell": s.withProject(sh)})
			return
		}
	}
	sh, err := s.d.Shells.StartShell(context.WithoutCancel(r.Context()), filepath.Clean(cwd), body.Cols, body.Rows)
	if err == nil && body.Replaces != "" {
		s.replaced[body.Replaces] = sh.ID
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if body.Type != "" && body.Replaces == "" {
		if body.Run {
			if t, ok := s.d.Shells.(interface{ RunAtPrompt(id, text string) }); ok {
				t.RunAtPrompt(sh.ID, body.Type)
			}
		} else if t, ok := s.d.Shells.(interface{ TypeAtPrompt(id, text string) }); ok {
			t.TypeAtPrompt(sh.ID, body.Type)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"shell": s.withProject(sh)})
}

// replacement is the running shell already started in place of session id,
// forgetting the ones that have ended. The caller holds replMu.
func (s *Server) replacement(id string) (ShellInfo, bool) {
	live := map[string]ShellInfo{}
	for _, sh := range s.d.Shells.Shells() {
		live[sh.ID] = sh
	}
	for k, v := range s.replaced {
		if _, ok := live[v]; !ok {
			delete(s.replaced, k)
		}
	}
	sh, ok := live[s.replaced[id]]
	return sh, ok
}

// handleShells lists the running shells, of one project with ?project=<id>.
func (s *Server) handleShells(w http.ResponseWriter, r *http.Request) {
	if s.d.Shells == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "shells are unavailable"})
		return
	}
	var want int64
	if q := r.URL.Query().Get("project"); q != "" {
		n, err := strconv.ParseInt(q, 10, 64)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "project is a project id"})
			return
		}
		want = n
	}
	out := []ShellInfo{}
	for _, sh := range s.d.Shells.Shells() {
		sh = s.withProject(sh)
		if want != 0 && sh.ProjectID != want {
			continue
		}
		out = append(out, sh)
	}
	writeJSON(w, http.StatusOK, map[string]any{"shells": out})
}

// withProject fills in which listed project a shell's folder is in.
func (s *Server) withProject(sh ShellInfo) ShellInfo {
	sh.Internal, sh.Kind = true, agents.KindShell
	if s.d.Projects != nil {
		if p, ok := s.d.Projects.ProjectFor(sh.Cwd); ok {
			sh.ProjectID = p.ID
		}
	}
	return sh
}

// refuseShellToDevice answers 403 when a paired device reaches a shell's
// terminal, input or signal: shells from the phone are P1. True when it
// refused.
func (s *Server) refuseShellToDevice(w http.ResponseWriter, r *http.Request, id string) bool {
	if !phoneLimited(r) || s.d.Shells == nil || !s.d.Shells.IsShell(id) {
		return false
	}
	writeJSON(w, http.StatusForbidden, map[string]string{"error": "shells are used on the machine Caprock runs on"})
	return true
}
