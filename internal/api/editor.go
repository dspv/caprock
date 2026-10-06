package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/dspv/caprock/internal/editor"
)

// EditorController finds the user's editors and opens a folder or a file in
// one (internal/editor). nil ⇒ the endpoints answer 501.
type EditorController interface {
	// List is the installed editors and the id of the one used when none is
	// named.
	List() (editors []editor.Editor, preferred string)
	// Open opens path, at line when it is above zero, in the editor with this
	// id ("" for the preferred one).
	Open(ctx context.Context, id, path string, line int) (editor.Editor, error)
}

// errEditorNotLocal is the refusal for any request not made on this machine.
var errEditorNotLocal = errors.New("an editor opens on the screen of the machine Caprock runs on, so only that machine may ask")

// handleEditors lists the editors installed here. Local only, like opening
// one: a phone has no use for the list.
func (s *Server) handleEditors(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errEditorNotLocal)
		return
	}
	if s.d.Editors == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("opening an editor is not available"))
		return
	}
	es, preferred := s.d.Editors.List()
	if es == nil {
		es = []editor.Editor{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"editors": es, "preferred": preferred})
}

// handleOpenEditor opens a folder, or a file at a line, in the user's editor
// (F18). It is refused for anything but a request from this machine — never
// a paired phone, never a tunnel — whatever the device's role: it acts on
// the screen of the Mac, which is not where a phone's owner is looking. The
// device allowlists in lanauth.go do not name it either.
func (s *Server) handleOpenEditor(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errEditorNotLocal)
		return
	}
	if s.d.Editors == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("opening an editor is not available"))
		return
	}
	var body struct {
		Editor string `json:"editor"`
		Path   string `json:"path"`
		Line   int    `json:"line"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&body); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New("bad request: want {path, line?, editor?}"))
		return
	}
	e, err := s.d.Editors.Open(r.Context(), body.Editor, body.Path, body.Line)
	if err != nil {
		code := http.StatusBadGateway
		if errors.Is(err, editor.ErrBadPath) || errors.Is(err, editor.ErrNoEditor) {
			code = http.StatusBadRequest
		}
		s.failCode(w, code, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"editor": e})
}
