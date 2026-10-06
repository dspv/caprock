package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"

	"github.com/dspv/caprock/internal/projects"
	"github.com/dspv/caprock/internal/store"
)

// Changes: a worktree's status and diffs, and staging, discarding,
// committing, pushing and pulling it (contract in 03-contracts.md
// § Changes). A worktree is named by ?worktree=<git's name>; absent means
// the project's main checkout. Reads are open to every paired device, as a
// session's diff is; every write is a controller's (ADR-034, amended
// 2026-10-06), and from a device only in a worktree under home.

// changeStatus maps a ChangeError's kind to the HTTP status it answers with.
func changeStatus(kind string) int {
	switch kind {
	case projects.KindInvalid:
		return http.StatusBadRequest
	case projects.KindState, projects.KindStale:
		return http.StatusConflict
	default:
		// The request was fine; git, a hook or the remote said no.
		return http.StatusUnprocessableEntity
	}
}

// changeFail answers an error from a Changes call: 404 for an unknown
// project or worktree, else the ChangeError's status with {error, kind,
// output?, preview?}.
func changeFail(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrProjectNotFound) || errors.Is(err, projects.ErrNoWorktree) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	var ce *projects.ChangeError
	if !errors.As(err, &ce) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error(), "kind": projects.KindGit})
		return
	}
	body := map[string]any{"error": ce.Message, "kind": ce.Kind}
	if ce.Output != "" {
		body["output"] = ce.Output
	}
	if ce.Preview != nil {
		body["preview"] = ce.Preview
	}
	writeJSON(w, changeStatus(ce.Kind), body)
}

// changeTarget reads the project id and ?worktree= of a Changes request.
// From a device, a write must land in a folder under home; ok is false once
// it has answered.
func (s *Server) changeTarget(w http.ResponseWriter, r *http.Request, write bool) (id int64, worktree string, ok bool) {
	if !s.requireProjects(w) {
		return 0, "", false
	}
	id, ok = pathID(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such project"})
		return 0, "", false
	}
	worktree = r.URL.Query().Get("worktree")
	if !write || deviceFrom(r) == nil {
		return id, worktree, true
	}
	if !s.deviceMayTouchProject(w, r, id) {
		return 0, "", false
	}
	dir, err := s.d.Projects.WorktreePath(r.Context(), id, worktree)
	if err != nil {
		changeFail(w, err)
		return 0, "", false
	}
	if !underHome(filepath.Clean(dir), false) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "a phone commits and pushes in worktrees under your home directory"})
		return 0, "", false
	}
	return id, worktree, true
}

// changeBody decodes a write's JSON body into v; an empty body is {}.
func changeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v)
	if err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request body", "kind": projects.KindInvalid})
		return false
	}
	return true
}

// logDevice records a write a paired device made.
func (s *Server) logDevice(r *http.Request, what string, id int64, worktree string) {
	if dev := deviceFrom(r); dev != nil {
		s.d.Log.Info(what+" from a paired device", "component", "api", "project", id, "worktree", worktree, "device", dev.ID, "device_name", dev.Name)
	}
}

func (s *Server) handleChanges(w http.ResponseWriter, r *http.Request) {
	id, wt, ok := s.changeTarget(w, r, false)
	if !ok {
		return
	}
	c, err := s.d.Projects.Changes(r.Context(), id, wt)
	if err != nil {
		changeFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleChangeDiff(w http.ResponseWriter, r *http.Request) {
	id, wt, ok := s.changeTarget(w, r, false)
	if !ok {
		return
	}
	q := r.URL.Query()
	fp, err := s.d.Projects.Diff(r.Context(), id, wt, q.Get("path"), q.Get("staged") == "1" || q.Get("staged") == "true")
	if err != nil {
		changeFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, fp)
}

// stageRequest is the body of stage and unstage: files, all of them, or one
// hunk.
type stageRequest struct {
	Paths []string       `json:"paths,omitempty"`
	All   bool           `json:"all,omitempty"`
	Hunk  *projects.Hunk `json:"hunk,omitempty"`
}

func (s *Server) handleStage(unstage bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, wt, ok := s.changeTarget(w, r, true)
		if !ok {
			return
		}
		var req stageRequest
		if !changeBody(w, r, &req) {
			return
		}
		op := s.d.Projects.Stage
		if unstage {
			op = s.d.Projects.Unstage
		}
		c, err := op(context.WithoutCancel(r.Context()), id, wt, req.Paths, req.All, req.Hunk)
		if err != nil {
			changeFail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"changes": c})
	}
}

func (s *Server) handleDiscard(w http.ResponseWriter, r *http.Request) {
	id, wt, ok := s.changeTarget(w, r, true)
	if !ok {
		return
	}
	var req struct {
		Paths   []string `json:"paths"`
		Confirm string   `json:"confirm,omitempty"`
	}
	if !changeBody(w, r, &req) {
		return
	}
	preview, c, err := s.d.Projects.Discard(context.WithoutCancel(r.Context()), id, wt, req.Paths, req.Confirm)
	if err != nil {
		changeFail(w, err)
		return
	}
	if preview != nil {
		writeJSON(w, http.StatusOK, map[string]any{"preview": preview})
		return
	}
	s.logDevice(r, "changes discarded", id, wt)
	writeJSON(w, http.StatusOK, map[string]any{"changes": c})
}

func (s *Server) handleCommit(w http.ResponseWriter, r *http.Request) {
	id, wt, ok := s.changeTarget(w, r, true)
	if !ok {
		return
	}
	var req struct {
		Message string `json:"message"`
		All     bool   `json:"all,omitempty"`
	}
	if !changeBody(w, r, &req) {
		return
	}
	res, c, err := s.d.Projects.Commit(context.WithoutCancel(r.Context()), id, wt, req.Message, req.All)
	if err != nil {
		changeFail(w, err)
		return
	}
	s.logDevice(r, "commit", id, wt)
	writeJSON(w, http.StatusOK, map[string]any{"commit": res, "changes": c})
}

// handleRemote serves push, pull and fetch, which take no body.
func (s *Server) handleRemote(what string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, wt, ok := s.changeTarget(w, r, true)
		if !ok {
			return
		}
		op := s.d.Projects.Fetch
		switch what {
		case "push":
			op = s.d.Projects.Push
		case "pull":
			op = s.d.Projects.Pull
		}
		res, c, err := op(context.WithoutCancel(r.Context()), id, wt)
		if err != nil {
			changeFail(w, err)
			return
		}
		s.logDevice(r, what, id, wt)
		writeJSON(w, http.StatusOK, map[string]any{"result": res, "changes": c})
	}
}
