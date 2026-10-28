package api

import (
	"errors"
	"net/http"

	"github.com/dspv/caprock/internal/projects"
)

// The Files tab (ADR-089; contract in 03-contracts.md § Files tab): a
// two-panel file manager over a project's checkout and its worktrees. The
// reads are open to every paired device, as the file tab's are; the writes
// are this machine's only — no paired device, controller or computer
// included, may copy, move, make or trash anything, so nothing over the
// relay or the LAN changes a file here. Every path is confined to a root
// Caprock already tracks (internal/projects/fsops.go).

// fsFail answers a refused or failed Files call.
func fsFail(w http.ResponseWriter, err error) {
	var ex *projects.ExistsError
	if errors.As(err, &ex) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": ex.Error(), "kind": "exists", "exists": ex.Names})
		return
	}
	fileFail(w, err)
}

// fsListing is a listing with what this caller may do with it.
type fsListing struct {
	projects.FsListing
	// Writable is false for a paired device: Files is read-only there.
	Writable bool `json:"writable"`
	// TrashOff says why Delete is off on this machine; empty when it works.
	TrashOff string `json:"trash_off,omitempty"`
}

func (s *Server) handleFsList(w http.ResponseWriter, r *http.Request) {
	id, wt, ok := s.changeTarget(w, r, false)
	if !ok {
		return
	}
	l, err := s.d.Projects.ListDir(r.Context(), id, wt, r.URL.Query().Get("path"))
	if err != nil {
		fsFail(w, err)
		return
	}
	out := fsListing{FsListing: l, Writable: deviceFrom(r) == nil}
	if ok, why := projects.TrashSupported(); !ok {
		out.TrashOff = why
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleFsCompare(w http.ResponseWriter, r *http.Request) {
	id, wt, ok := s.changeTarget(w, r, false)
	if !ok {
		return
	}
	q := r.URL.Query()
	c, err := s.d.Projects.CompareDir(r.Context(), id, wt, q.Get("other"), q.Get("path"))
	if err != nil {
		fsFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleFsChanged(w http.ResponseWriter, r *http.Request) {
	id, wt, ok := s.changeTarget(w, r, false)
	if !ok {
		return
	}
	c, err := s.d.Projects.Changed(r.Context(), id, wt, r.URL.Query().Get("base"))
	if err != nil {
		fsFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleFsDiff(w http.ResponseWriter, r *http.Request) {
	id, wt, ok := s.changeTarget(w, r, false)
	if !ok {
		return
	}
	q := r.URL.Query()
	d, err := s.d.Projects.DiffFile(r.Context(), id, wt, q.Get("other"), q.Get("path"))
	if err != nil {
		fsFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// fsWriteTarget is a Files write's project, refused for any paired device.
func (s *Server) fsWriteTarget(w http.ResponseWriter, r *http.Request) (int64, bool) {
	if deviceFrom(r) != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Files changes nothing from another device: copy, move, new folder and delete happen on the computer Caprock runs on"})
		return 0, false
	}
	id, _, ok := s.changeTarget(w, r, true)
	return id, ok
}

// fsBody is every Files write's body; each call reads its own fields.
type fsBody struct {
	// From and To are worktree names ("" the main checkout); Worktree is a
	// mkdir's or a trash's.
	From      string   `json:"from"`
	To        string   `json:"to"`
	Worktree  string   `json:"worktree"`
	Paths     []string `json:"paths"`
	Dir       string   `json:"dir"`
	Name      string   `json:"name"`
	Overwrite bool     `json:"overwrite"`
}

func (s *Server) handleFsWrite(op string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := s.fsWriteTarget(w, r)
		if !ok {
			return
		}
		var b fsBody
		if !changeBody(w, r, &b) {
			return
		}
		ctx := r.Context()
		var res projects.FsResult
		var err error
		switch op {
		case "copy":
			res, err = s.d.Projects.Copy(ctx, id, b.From, b.Paths, b.To, b.Dir, b.Overwrite)
		case "move":
			res, err = s.d.Projects.Move(ctx, id, b.From, b.Paths, b.To, b.Dir, b.Name)
		case "mkdir":
			res, err = s.d.Projects.Mkdir(ctx, id, b.Worktree, b.Dir, b.Name)
		case "trash":
			res, err = s.d.Projects.Trash(ctx, id, b.Worktree, b.Paths)
		}
		if err != nil {
			fsFail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
	}
}
