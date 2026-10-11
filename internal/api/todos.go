package api

import (
	"net/http"

	"github.com/dspv/caprock/internal/store"
)

// handleSessionTodos returns the task list the session's agent keeps for
// itself, rebuilt from its own TodoWrite, TaskCreate/TaskUpdate and
// update_plan calls (store.SessionTodos). A session that never kept one, or an
// unknown id, answers {items: [], updated_at: 0}: the inspector hides the
// block on an empty list, so there is nothing for a 404 to tell it.
func (s *Server) handleSessionTodos(w http.ResponseWriter, r *http.Request) {
	list, err := store.SessionTodos(r.Context(), s.d.Store.DB(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}
