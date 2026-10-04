package api

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/relay"
	"github.com/dspv/caprock/internal/store"
)

// handleRelayBrief proposes the first message for a session that carries this
// one's work on, in any agent: its last substantial passage, the working tree
// now, and the PRs it opened (internal/relay). Built locally; nothing is sent
// anywhere until the user, having read and perhaps edited it, starts the new
// session with it.
func (s *Server) handleRelayBrief(w http.ResponseWriter, r *http.Request) {
	sess, err := store.GetSession(r.Context(), s.d.Store.DB(), r.PathValue("id"))
	if err != nil {
		s.notFoundOrFail(w, err)
		return
	}
	b, err := relay.Build(r.Context(), s.d.Store.DB(), sess, s.d.Now())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, b)
}

// checkRelay refuses a relay or first-message spawn that cannot be what the
// user asked for, with a reason the dialog shows. "" means go ahead.
func (s *Server) checkRelay(ctx context.Context, req map[string]any) string {
	prompt, _ := req["prompt"].(string)
	from, _ := req["relay_from"].(string)
	resume, _ := req["resume"].(string)
	if prompt != "" && resume != "" {
		return "A continued session already has its conversation; start a new one to send a brief."
	}
	if n := utf8.RuneCountInString(prompt); n > relay.MaxPromptRunes {
		return fmt.Sprintf("The brief is %d characters; the most a first message can carry here is %d.", n, relay.MaxPromptRunes)
	}
	if from == "" {
		return ""
	}
	if resume != "" {
		return "A relay starts a new session; it cannot also continue one."
	}
	src, err := store.GetSession(ctx, s.d.Store.DB(), from)
	if err != nil {
		return "Caprock has no record of the session to carry on."
	}
	if cwd, _ := req["cwd"].(string); cwd == "" && !dirExists(src.Cwd) {
		return "The folder that session worked in no longer exists."
	}
	return ""
}

// dirExists reports whether p names a directory.
func dirExists(p string) bool {
	if p == "" {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}
