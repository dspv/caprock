package api

import (
	"errors"
	"net/http"

	"github.com/dspv/caprock/internal/projects"
)

// Files: one file of a project, read-only, and the list of its files, for
// the app's file tab and the palette's "Open file…" (contract in
// 03-contracts.md § Files). Both are reads, open to every paired device as
// a worktree's diff is; nothing here writes.

// fileFail answers a refused or failed read.
func fileFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, projects.ErrFileEscape):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
	case errors.Is(err, projects.ErrNotRegular):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error(), "kind": projects.KindInvalid})
	case errors.Is(err, projects.ErrNoFile):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, projects.ErrNotImage):
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": err.Error()})
	case errors.Is(err, projects.ErrTooLarge):
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": err.Error()})
	default:
		changeFail(w, err)
	}
}

func (s *Server) handleProjectFile(w http.ResponseWriter, r *http.Request) {
	id, wt, ok := s.changeTarget(w, r, false)
	if !ok {
		return
	}
	f, err := s.d.Projects.ReadFile(r.Context(), id, wt, r.URL.Query().Get("path"))
	if err != nil {
		fileFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, f)
}

// handleProjectImage serves a picture of the project as bytes, for an image
// in a Markdown file the file tab renders. Only image types; an SVG is sent
// under a sandboxing policy so, opened on its own, its scripts never run.
func (s *Server) handleProjectImage(w http.ResponseWriter, r *http.Request) {
	id, wt, ok := s.changeTarget(w, r, false)
	if !ok {
		return
	}
	b, typ, err := s.d.Projects.ReadImage(r.Context(), id, wt, r.URL.Query().Get("path"))
	if err != nil {
		fileFail(w, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", typ)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
}

func (s *Server) handleProjectFiles(w http.ResponseWriter, r *http.Request) {
	id, wt, ok := s.changeTarget(w, r, false)
	if !ok {
		return
	}
	l, err := s.d.Projects.ListFiles(r.Context(), id, wt)
	if err != nil {
		fileFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, l)
}
