package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/dspv/caprock/internal/templates"
)

// New project from a template (ADR-065; contract in 03-contracts.md §
// Project templates). Every route here is the machine's: none is on a paired
// device's or a controller's list, so a phone gets 403 from the gate.

// maxFromTemplateBody is the largest POST /v1/projects/from-template: a
// brief of up to 1 MiB, JSON-escaped, and the rest.
const maxFromTemplateBody = 2 << 20

func (s *Server) requireTemplates(w http.ResponseWriter) bool {
	if s.d.Templates == nil || s.d.Templates.Store == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "project templates are unavailable"})
		return false
	}
	return true
}

// templateErr answers a templates error with its own status, else 400.
func templateErr(w http.ResponseWriter, err error) {
	code := http.StatusBadRequest
	var te *templates.Error
	switch {
	case errors.As(err, &te):
		code = te.Status
	case errors.Is(err, templates.ErrNotFound):
		code = http.StatusNotFound
	}
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

// decodeLimited reads a JSON body of at most limit bytes; false (answered)
// when it is larger or not JSON.
func decodeLimited(w http.ResponseWriter, r *http.Request, limit int64, v any, shape string) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	if err := dec.Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "the request is too large"})
			return false
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body is " + shape})
		return false
	}
	return true
}

// handleTemplates is GET /v1/templates: the person's templates and whether
// their gh can make a repository (read from gh's own config; nothing sent).
func (s *Server) handleTemplates(w http.ResponseWriter, r *http.Request) {
	if !s.requireTemplates(w) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"templates": s.d.Templates.Store.List(),
		"gh":        s.d.Templates.GH(r.Context()),
	})
}

const templateShape = "{name, github?, folder?, brief_path, prompt, agent?}"

// handleAddTemplate is POST /v1/templates.
func (s *Server) handleAddTemplate(w http.ResponseWriter, r *http.Request) {
	if !s.requireTemplates(w) {
		return
	}
	var in templates.Input
	if !decodeLimited(w, r, 64<<10, &in, templateShape) {
		return
	}
	t, err := s.d.Templates.Store.Add(in)
	if err != nil {
		templateErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"template": t})
}

// handlePatchTemplate is PATCH /v1/templates/{id}.
func (s *Server) handlePatchTemplate(w http.ResponseWriter, r *http.Request) {
	if !s.requireTemplates(w) {
		return
	}
	var in templates.Input
	if !decodeLimited(w, r, 64<<10, &in, templateShape) {
		return
	}
	t, err := s.d.Templates.Store.Update(r.PathValue("id"), in)
	if err != nil {
		templateErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"template": t})
}

// handleDeleteTemplate is DELETE /v1/templates/{id}: off the list; nothing
// on disk or on GitHub is touched.
func (s *Server) handleDeleteTemplate(w http.ResponseWriter, r *http.Request) {
	if !s.requireTemplates(w) {
		return
	}
	if err := s.d.Templates.Store.Delete(r.PathValue("id")); err != nil {
		templateErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// defaultFolder is settings.default_folder, "" when unset.
func (s *Server) defaultFolder() string {
	if s.d.Settings == nil {
		return ""
	}
	return strings.TrimSpace(s.d.Settings.Get().DefaultFolder)
}

// handleInspectTemplate is POST /v1/templates/inspect {github?|folder?}:
// what the template says about itself, read on this click.
func (s *Server) handleInspectTemplate(w http.ResponseWriter, r *http.Request) {
	if !s.requireTemplates(w) {
		return
	}
	var req struct {
		GitHub string `json:"github"`
		Folder string `json:"folder"`
	}
	if !decodeLimited(w, r, 8<<10, &req, "{github?, folder?}") {
		return
	}
	res, err := s.d.Templates.Inspect(r.Context(), req.GitHub, req.Folder, s.defaultFolder())
	if err != nil {
		templateErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleFromTemplate is POST /v1/projects/from-template: starts making the
// project and answers at once with the operation.
func (s *Server) handleFromTemplate(w http.ResponseWriter, r *http.Request) {
	if !s.requireTemplates(w) || !s.requireProjects(w) {
		return
	}
	var req templates.CreateRequest
	if !decodeLimited(w, r, maxFromTemplateBody, &req, "{op_id, source: {github?, folder?}, via, name, parent, visibility, brief, brief_path, template_name}") {
		return
	}
	op, existing, err := s.d.Templates.FromTemplate(context.WithoutCancel(r.Context()), req)
	if err != nil {
		templateErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"op": op, "existing": existing})
}

// handleRetryOp is POST /v1/projects/ops/{op_id}/retry: a failed template
// operation, again from the step it failed at.
func (s *Server) handleRetryOp(w http.ResponseWriter, r *http.Request) {
	if !s.requireTemplates(w) || !s.requireProjects(w) {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 4<<10))
	op, err := s.d.Templates.Retry(context.WithoutCancel(r.Context()), r.PathValue("op_id"))
	if err != nil {
		templateErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"op": op})
}
