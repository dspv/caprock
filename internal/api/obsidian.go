package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/dspv/caprock/internal/obsidian"
	"github.com/dspv/caprock/internal/store"
)

// Vault configuration is machine-only: it contains local paths and permission
// to include personal notes in an agent's context (ADR-079).
func (s *Server) handleBrainVaults(w http.ResponseWriter, r *http.Request) {
	vaults, err := store.ListBrainVaults(r.Context(), s.d.Store.DB())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"vaults": vaults})
}

func (s *Server) vaultService(w http.ResponseWriter) *obsidian.Service {
	if s.d.Obsidian == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Obsidian import is not available in this build"})
	}
	return s.d.Obsidian
}

func vaultBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad JSON"})
		return false
	}
	if err := dec.Decode(new(any)); !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body must be one JSON object within 8 KiB"})
		return false
	}
	return true
}

func (s *Server) vaultError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrVaultExists):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, store.ErrVaultNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, obsidian.ErrNotFolder), errors.Is(err, obsidian.ErrNotAbsolute), errors.Is(err, obsidian.ErrTooMany):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	default:
		s.fail(w, err)
	}
}

func (s *Server) handleAddBrainVault(w http.ResponseWriter, r *http.Request) {
	svc := s.vaultService(w)
	if svc == nil {
		return
	}
	var b struct {
		Path   string `json:"path"`
		Agents bool   `json:"agents"`
	}
	if !vaultBody(w, r, &b) {
		return
	}
	v, result, err := svc.Add(r.Context(), b.Path, b.Agents)
	if err != nil {
		s.vaultError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"vault": v, "result": result})
}

func (s *Server) handleRefreshBrainVault(w http.ResponseWriter, r *http.Request) {
	svc := s.vaultService(w)
	if svc == nil {
		return
	}
	id, ok := brainID(w, r)
	if !ok {
		return
	}
	v, result, err := svc.Refresh(r.Context(), id, true)
	if err != nil {
		s.vaultError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"vault": v, "result": result})
}

func (s *Server) handlePatchBrainVault(w http.ResponseWriter, r *http.Request) {
	svc := s.vaultService(w)
	if svc == nil {
		return
	}
	id, ok := brainID(w, r)
	if !ok {
		return
	}
	var b struct {
		Agents *bool `json:"agents"`
	}
	if !vaultBody(w, r, &b) {
		return
	}
	if b.Agents == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agents is required"})
		return
	}
	v, err := svc.SetAgents(r.Context(), id, *b.Agents)
	if err != nil {
		s.vaultError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"vault": v})
}

func (s *Server) handleRemoveBrainVault(w http.ResponseWriter, r *http.Request) {
	svc := s.vaultService(w)
	if svc == nil {
		return
	}
	id, ok := brainID(w, r)
	if !ok {
		return
	}
	if err := svc.Remove(r.Context(), id); err != nil {
		s.vaultError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"removed": true})
}
