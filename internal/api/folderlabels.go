package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/dspv/caprock/internal/store"
)

// Folder labels (ADR-091, contract in 03-contracts.md § Folder labels): Work
// or Personal on a folder, set from New chat's Where step and drawn as a tag
// there and on the Chats list. A label in Caprock's own database, like a
// session's name; it runs nothing and reads no folder. Every paired device
// reads them; a controller sets them, for a folder under home.

// folderLabelDirMax caps the path a label is kept for.
const folderLabelDirMax = 4096

// FolderLabels is GET /v1/folder-labels.
type FolderLabels struct {
	Labels []store.FolderLabel `json:"labels"`
}

func (s *Server) handleFolderLabels(w http.ResponseWriter, r *http.Request) {
	list, err := store.ListFolderLabels(r.Context(), s.d.Store.DB())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, FolderLabels{Labels: list})
}

// handleSetFolderLabel is PUT /v1/folder-labels {dir, label}: label is
// "work", "personal", or "" to remove it. Answers the whole list.
func (s *Server) handleSetFolderLabel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Dir   string  `json:"dir"`
		Label *string `json:"label"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&body); err != nil || body.Label == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body is {"dir": "/abs/path", "label": "work"|"personal"|""}`})
		return
	}
	label := strings.TrimSpace(*body.Label)
	if label != "" && !store.ValidFolderLabel(label) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `label is "work", "personal" or "" (none)`})
		return
	}
	dir := strings.TrimSpace(body.Dir)
	if dir == "" || len(dir) > folderLabelDirMax || strings.ContainsAny(dir, "\x00\n\r") || !filepath.IsAbs(dir) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "dir is an absolute path"})
		return
	}
	dir = filepath.Clean(dir)
	// A phone labels what it may start in: a folder under home (ADR-034).
	if phoneLimited(r) && !underHome(dir, false) {
		s.failCode(w, http.StatusForbidden, errors.New("a phone labels folders under your home directory"))
		return
	}
	ctx := r.Context()
	if err := store.SetFolderLabel(ctx, s.d.Store.DB(), dir, label, s.d.Now().UnixMilli()); err != nil {
		s.fail(w, err)
		return
	}
	s.handleFolderLabels(w, r)
}
