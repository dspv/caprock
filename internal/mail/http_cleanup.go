package mail

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/dspv/caprock/internal/mail/engine"
	store "github.com/dspv/caprock/internal/mail/mailstore"
)

type cleanupReq struct {
	store.CleanupQuery
	// Execute accepts only the reviewed snapshot. Newly arrived mail is excluded.
	IDs        []int64          `json:"ids"`
	Identities map[int64]string `json:"identities"`
}

func (s *Service) cleanup(w http.ResponseWriter, r *http.Request) {
	var req cleanupReq
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	if err := req.Validate(); err != nil {
		fail(w, 400, err)
		return
	}
	execute := r.URL.Path == "/v1/mail/cleanup"
	if execute && (req.IDs == nil || req.Identities == nil) {
		fail(w, 400, errors.New("review the cleanup selection first"))
		return
	}
	s.with(w, r, func(st *store.Store, eng *engine.Engine) {
		ids, identities, err := st.CleanupSnapshot(r.Context(), req.CleanupQuery)
		if err != nil {
			fail(w, 500, err)
			return
		}
		if !execute {
			writeJSON(w, map[string]any{"ids": ids, "identities": identities})
			return
		}
		// Revalidate both scope and eligibility: restored mail must not be deleted,
		// and mail arriving after the preview must not be silently added.
		requested := make(map[int64]bool, len(req.IDs))
		for _, id := range req.IDs {
			requested[id] = true
		}
		selected := make([]int64, 0, len(ids))
		for _, id := range ids {
			if requested[id] && req.Identities[id] == identities[id] {
				selected = append(selected, id)
			}
		}
		for len(selected) > 0 {
			n := min(200, len(selected))
			if err := eng.Cleanup(r.Context(), selected[:n], req.View, req.Identities); err != nil {
				fail(w, 502, fmt.Errorf("cleanup stopped; some messages may already have been processed. Refresh before trying again: %w", err))
				return
			}
			selected = selected[n:]
		}
		writeJSON(w, map[string]bool{"ok": true})
	})
}
