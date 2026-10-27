package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"

	"github.com/dspv/caprock/internal/store"
)

// handleQueueResend is POST /v1/agents/{id}/queue/resend {ids?}: the
// messages a session's process ended before typing in go to a new session
// of the same agent in the same folder (ADR-053, 2026-10-27). It continues
// the ended conversation (--resume) when it can be continued here, as the
// pick-up button does, else it starts a fresh session there. The messages
// then wait in that session's queue and go in through it: the first once
// the session's SessionStart has settled, the rest one per turn. A session
// that runs again takes them back into its own queue instead. No ids is all
// of them, in their order.
func (s *Server) handleQueueResend(w http.ResponseWriter, r *http.Request) {
	q, ok := s.queuer(w)
	if !ok {
		return
	}
	rs, ok := q.(QueueResender)
	if !ok {
		s.failCode(w, http.StatusNotImplemented, errors.New("this daemon cannot send queued messages on"))
		return
	}
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, `body must be {"ids": [<id>, …]} or empty`, http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	from := r.PathValue("id")
	v, err := q.View(ctx, from)
	if err != nil {
		s.queueFail(w, err)
		return
	}
	if !holdsAny(v.Undelivered, body.IDs) {
		s.queueFail(w, store.ErrQueuedNotFound)
		return
	}
	// Running again (resumed under its own id elsewhere): its own queue.
	if s.d.Agents != nil && s.d.Agents.Holds(from) {
		qv, err := rs.Resend(ctx, from, from, body.IDs, false)
		if err != nil {
			s.queueFail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, ResendResult{SessionID: qv.SessionID, Queue: qv})
		return
	}
	if !s.requireAgents(w) {
		return
	}
	sess, err := store.GetSession(ctx, s.d.Store.DB(), from)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such session"})
		return
	}
	req, resumed, msg := s.resendRequest(sess)
	if msg != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
		return
	}
	if phoneLimited(r) {
		if msg := s.controllerSpawnRefusal(req); msg != "" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": msg})
			return
		}
	}
	s.defaultSpawnMode(ctx, req)
	if s.needsBypassConsent(req) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": bypassConsentMsg, "code": "bypass_consent"})
		return
	}
	// The process and the hand-over outlive this request.
	bg := context.WithoutCancel(ctx)
	id, _, err := s.d.Agents.Spawn(bg, req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	qv, err := rs.Resend(bg, from, id, body.IDs, true)
	if err != nil {
		s.queueFail(w, err)
		return
	}
	s.d.Log.Info("sent undelivered messages to a new session", "component", "api", "from", from, "session", id, "resumed", resumed)
	writeJSON(w, http.StatusOK, ResendResult{SessionID: id, Resumed: resumed, Started: true, Queue: qv})
}

// resendRequest is the start request for Send to a new session: the ended
// conversation continued from the folder it began in when it can be
// continued here, else a fresh session of the same agent in its folder.
// msg says why neither can start.
func (s *Server) resendRequest(sess store.Session) (req map[string]any, resumed bool, msg string) {
	req = map[string]any{"cwd": sess.Cwd}
	if info := s.resumeState(sess); info != nil && info.OK {
		req["resume"], req["fork"] = sess.SessionID, false
		if a := sess.Agent; a == "" || a == "claude" {
			if dir := claudeStartDir(sess, sess.Cwd); dir != sess.Cwd {
				req["cwd"] = dir
			}
		}
		return req, true, ""
	}
	if st, err := os.Stat(sess.Cwd); sess.Cwd == "" || err != nil || !st.IsDir() {
		return nil, false, "The folder it ran in no longer exists, so there is nowhere to start a new session. Copy the messages instead."
	}
	agent := sess.Agent
	if agent == "" {
		agent = "claude"
	}
	req["agent"] = agent
	return req, false, ""
}

// holdsAny says whether msgs has every one of ids — or anything at all, when
// ids is empty.
func holdsAny(msgs []store.QueuedMessage, ids []int64) bool {
	if len(ids) == 0 {
		return len(msgs) > 0
	}
	have := make(map[int64]bool, len(msgs))
	for _, m := range msgs {
		have[m.ID] = true
	}
	for _, id := range ids {
		if !have[id] {
			return false
		}
	}
	return true
}
