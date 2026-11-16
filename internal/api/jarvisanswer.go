package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/store"
)

// Jarvis V2's core (ADR-096, .ai/03-contracts.md § Jarvis): a question
// dialog answered from its decision card, and the Handled for you log.

// questionAnswerer is the optional half of AgentController that presses an
// option in an owned session's question dialog (agents.AnswerQuestion).
type questionAnswerer interface {
	AnswerQuestion(sessionID string, input json.RawMessage, option int, text string) error
}

// Why an answer was refused; ErrJarvisNotAnswerable and ErrJarvisGone wrap
// the agents errors for callers outside this package (the brain).
var (
	// ErrJarvisNotStarted: Caprock did not start the session, or does not
	// hold its terminal (rule 7). 403.
	ErrJarvisNotStarted = errors.New("caprock did not start this session, so it cannot answer it")
	// ErrJarvisGone: the session is not showing that question now. 409.
	ErrJarvisGone = errors.New("that question is no longer on the screen")
	// ErrJarvisNotAnswerable: the question has to be answered in the
	// terminal (several questions, a multi-select, not Claude Code). 422.
	ErrJarvisNotAnswerable = errors.New("this question has to be answered in the terminal")
)

// AnswerJarvis answers the question dialog session id is waiting on: option
// (0-based) when text is empty, else text typed on its Other row. Only a
// Claude Code session Caprock started and holds, only while the newest
// event is that dialog's hook and the dialog is on its screen; otherwise
// nothing is typed and the error says why.
func (s *Server) AnswerJarvis(ctx context.Context, id string, option int, text string) error {
	qa, ok := s.d.Agents.(questionAnswerer)
	if s.d.Agents == nil || !ok {
		return ErrJarvisNotStarted
	}
	db := s.d.Store.DB()
	sess, err := store.GetSession(ctx, db, id)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrJarvisNotStarted
	}
	if err != nil {
		return err
	}
	if !sess.Owned || !s.d.Agents.Holds(id) {
		return ErrJarvisNotStarted
	}
	gen, err := store.ReadEventsGen(ctx, db, id)
	if err != nil {
		return err
	}
	sum, last, err := s.summarizeAt(ctx, sess, s.recent.entry(id, gen))
	if err != nil {
		return err
	}
	act := sum.Activity
	prompt, has := lastPrompt(last)
	if act.Health != narrate.HealthWaiting || act.Need == nil || act.Need.Reason != narrate.NeedQuestion || !has || prompt.Tool != "AskUserQuestion" {
		return ErrJarvisGone
	}
	if d, ok := agents.ParseQuestion(toolInputOf(prompt.Payload)); !ok || !d.Answerable() ||
		firstNonEmpty(sess.Agent, agents.AgentClaude) != agents.AgentClaude {
		return ErrJarvisNotAnswerable
	}
	err = qa.AnswerQuestion(id, toolInputOf(prompt.Payload), option, text)
	switch {
	case errors.Is(err, agents.ErrNotOwned):
		return ErrJarvisNotStarted
	case errors.Is(err, agents.ErrQuestionGone):
		return ErrJarvisGone
	case errors.Is(err, agents.ErrQuestionNotAnswerable):
		return ErrJarvisNotAnswerable
	}
	return err
}

// handleJarvisAnswer is POST /v1/jarvis/answer {session_id, option?, text?}:
// 200 {ok: true} once the keys are typed; 400 for a body naming neither an
// option nor a text, 403 for a session Caprock did not start, 409 when the
// dialog is no longer on the screen, 422 for one a tap cannot answer.
func (s *Server) handleJarvisAnswer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID string `json:"session_id"`
		Option    *int   `json:"option"`
		Text      string `json:"text"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&body); err != nil || body.SessionID == "" ||
		(body.Option == nil && body.Text == "") || (body.Option != nil && *body.Option < 0) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body must be {"session_id": "…", "option": <0-based>} or {"session_id": "…", "text": "…"}`})
		return
	}
	opt := 0
	if body.Option != nil {
		opt = *body.Option
	}
	err := s.AnswerJarvis(r.Context(), body.SessionID, opt, body.Text)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case errors.Is(err, ErrJarvisNotStarted):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrJarvisGone):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrJarvisNotAnswerable):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
	default:
		// "no such option" from the key table, or a write that failed.
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	}
}

// handleJarvisHandled is GET /v1/jarvis/handled?since=<unix ms>&limit=<n>:
// {items: [HandledItem]}, newest first, at most 200.
func (s *Server) handleJarvisHandled(w http.ResponseWriter, r *http.Request) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, err := store.ListHandled(r.Context(), s.d.Store.DB(), max(since, 0), limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
