package api

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"

	"github.com/dspv/caprock/internal/projects"
)

// Multi-repo projects (ADR-055; contract in 03-contracts.md § Projects and
// shells). Scanning, splitting and merging are the machine's; a paired
// device reads a project's repositories like the rest of the list.

// allUnderHome reports whether every path is absolute and under home.
func allUnderHome(paths []string) bool {
	for _, p := range paths {
		if !filepath.IsAbs(p) || !underHome(filepath.Clean(p), false) {
			return false
		}
	}
	return true
}

// handleScanProject is GET /v1/projects/scan?path=: what adding a folder
// would add — the repository it is in, or the repositories below it.
func (s *Server) handleScanProject(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	res, err := s.d.Projects.Scan(r.Context(), r.URL.Query().Get("path"))
	if err != nil {
		projectErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleProjectRepos is GET /v1/projects/{id}/repos: a multi-repo project's
// members, git asked again where its answer is older than 30 s (the frame
// that follows carries it), and each member's open pull requests on GitHub
// when connected.
func (s *Server) handleProjectRepos(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such project"})
		return
	}
	repos, err := s.d.Projects.RepoViews(r.Context(), id, true)
	if err != nil {
		projectErr(w, err)
		return
	}
	if s.d.GitHub != nil {
		for i := range repos {
			if repos[i].Git == nil || repos[i].Git.RemoteURL == "" {
				continue
			}
			n, ok, reason := s.d.GitHub.OpenPullCount(r.Context(), repos[i].Git.RemoteURL)
			if ok {
				repos[i].OpenPRs = &n
			} else {
				repos[i].PRsError = reason
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"repos": repos})
}

// handleSplitProject is POST /v1/projects/{id}/split: each member becomes a
// project of its own and the multi-repo project is unlisted.
func (s *Server) handleSplitProject(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such project"})
		return
	}
	list, err := s.d.Projects.Split(r.Context(), id)
	if err != nil {
		projectErr(w, err)
		return
	}
	if list == nil {
		list = []projects.View{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": list})
}

// handleMergeProjects is POST /v1/projects/merge {ids}: one multi-repo
// project of their repositories.
func (s *Server) handleMergeProjects(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil || len(body.IDs) < 2 || len(body.IDs) > projects.MaxRepos {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body is {ids: [two project ids or more]}"})
		return
	}
	v, err := s.d.Projects.Merge(r.Context(), body.IDs)
	if err != nil {
		projectErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"project": v})
}
