package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/store"
)

// The message queue (ADR-053; contract in 03-contracts.md § Queued messages):
// what the chat field sends to a Claude Code session Caprock started is
// typed in at once when the session is at its prompt, and otherwise held by
// the daemon and typed in when the turn ends, one message per turn.

// Why a message is waiting, as GET /v1/agents/{id}/queue and the "queue"
// frame say it. Empty: nothing holds it.
const (
	WaitingTurn       = "turn"       // the agent is working
	WaitingPermission = "permission" // a permission prompt is on the screen
	WaitingQuestion   = "question"   // the agent asked a question (AskUserQuestion)
	// WaitingStart: a session started for messages it never got, before
	// its first hook (ADR-053, 2026-10-27). Read-only: never refuses.
	WaitingStart = "start"
)

// QueueMax is how many messages one session's queue holds.
const QueueMax = 20

// QueueTextMax is the longest message, in bytes.
const QueueTextMax = 16 << 10

var (
	// ErrQueueFull is the 21st message.
	ErrQueueFull = errors.New("this session already has 20 messages waiting")
	// ErrPromptWaiting refuses Send now while a menu is on the screen: the
	// text would answer it.
	ErrPromptWaiting = errors.New("the session is showing a prompt; answer it first, in the terminal or with the buttons")
	// ErrNotOwned is a session Caprock did not start, or that has ended
	// (rule 7: it types only into its own).
	ErrNotOwned = errors.New("caprock did not start this session, or it has ended, so it does not type into it")
)

// QueueView is a session's queue and why it waits.
type QueueView struct {
	SessionID string                `json:"session_id"`
	Messages  []store.QueuedMessage `json:"messages"`
	Waiting   string                `json:"waiting"`
	// Undelivered is what the session's process ended before typing in,
	// oldest first, kept 7 days (ADR-053, 2026-10-27); empty or absent
	// when there is none.
	Undelivered []store.QueuedMessage `json:"undelivered,omitempty"`
}

// SendResult is POST /v1/agents/{id}/queue's answer: typed in, or queued.
type SendResult struct {
	Sent   bool                 `json:"sent"`
	Queued *store.QueuedMessage `json:"queued,omitempty"`
	Queue  QueueView            `json:"queue"`
}

// Queuer is the daemon's message queue. Optional on Deps so a test server
// without one answers 501.
type Queuer interface {
	View(ctx context.Context, sessionID string) (QueueView, error)
	Send(ctx context.Context, sessionID, text string) (SendResult, error)
	Edit(ctx context.Context, sessionID string, id int64, text string) (QueueView, error)
	Cancel(ctx context.Context, sessionID string, id int64) (QueueView, error)
	SendNow(ctx context.Context, sessionID string, id int64) (QueueView, error)
}

// QueueResender sends undelivered messages on (ADR-053, 2026-10-27):
// Resend makes them wait again in session to's queue, from's own when it
// runs again; spawned says to was just started for them. Optional: a queue
// without it answers 501 to POST …/queue/resend.
type QueueResender interface {
	Resend(ctx context.Context, from, to string, ids []int64, spawned bool) (QueueView, error)
}

// ResendResult is POST /v1/agents/{id}/queue/resend's answer: the session
// the messages now wait in, whether it continues the ended conversation
// (--resume) or is a fresh one, and its queue.
type ResendResult struct {
	SessionID string    `json:"session_id"`
	Resumed   bool      `json:"resumed"`
	Started   bool      `json:"started"`
	Queue     QueueView `json:"queue"`
}

// cleanMessage checks a message as the chat field sends it: trailing
// whitespace trimmed, something left, valid UTF-8, no NUL, at most
// QueueTextMax bytes.
func cleanMessage(text string) (string, error) {
	text = strings.TrimRight(text, " \t\r\n")
	switch {
	case strings.TrimSpace(text) == "":
		return "", errors.New("the message is empty")
	case len(text) > QueueTextMax:
		return "", errors.New("the message is longer than 16 KiB")
	case !utf8.ValidString(text) || strings.ContainsRune(text, 0):
		return "", errors.New("the message is not valid text")
	}
	return text, nil
}

func (s *Server) queueFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrQueuedNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrNotOwned), errors.Is(err, ErrQueueFull), errors.Is(err, ErrPromptWaiting):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	default:
		s.failCode(w, http.StatusInternalServerError, err)
	}
}

func (s *Server) queuer(w http.ResponseWriter) (Queuer, bool) {
	if s.d.Queue == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this daemon has no message queue"))
		return nil, false
	}
	return s.d.Queue, true
}

func queuedID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("qid"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "bad queued message id", http.StatusBadRequest)
		return 0, false
	}
	return id, true
}

func readMessage(w http.ResponseWriter, r *http.Request) (string, bool) {
	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, QueueTextMax*2)).Decode(&body); err != nil {
		http.Error(w, `body must be {"text": "<message>"}`, http.StatusBadRequest)
		return "", false
	}
	text, err := cleanMessage(body.Text)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return "", false
	}
	return text, true
}

// handleQueue is GET /v1/agents/{id}/queue.
func (s *Server) handleQueue(w http.ResponseWriter, r *http.Request) {
	q, ok := s.queuer(w)
	if !ok {
		return
	}
	v, err := q.View(r.Context(), r.PathValue("id"))
	if err != nil {
		s.queueFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// handleQueueSend is POST /v1/agents/{id}/queue {text}: typed in now when the
// session is at its prompt with nothing queued, otherwise queued.
func (s *Server) handleQueueSend(w http.ResponseWriter, r *http.Request) {
	q, ok := s.queuer(w)
	if !ok {
		return
	}
	text, ok := readMessage(w, r)
	if !ok {
		return
	}
	if s.refuseShellToDevice(w, r, r.PathValue("id")) {
		return
	}
	res, err := q.Send(r.Context(), r.PathValue("id"), text)
	if err != nil {
		s.queueFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleQueueEdit is PATCH /v1/agents/{id}/queue/{qid} {text}.
func (s *Server) handleQueueEdit(w http.ResponseWriter, r *http.Request) {
	q, ok := s.queuer(w)
	if !ok {
		return
	}
	id, ok := queuedID(w, r)
	if !ok {
		return
	}
	text, ok := readMessage(w, r)
	if !ok {
		return
	}
	v, err := q.Edit(r.Context(), r.PathValue("id"), id, text)
	if err != nil {
		s.queueFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// handleQueueCancel is DELETE /v1/agents/{id}/queue/{qid}.
func (s *Server) handleQueueCancel(w http.ResponseWriter, r *http.Request) {
	q, ok := s.queuer(w)
	if !ok {
		return
	}
	id, ok := queuedID(w, r)
	if !ok {
		return
	}
	v, err := q.Cancel(r.Context(), r.PathValue("id"), id)
	if err != nil {
		s.queueFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// handleQueueSendNow is POST /v1/agents/{id}/queue/{qid}/send: type this one
// in now, whatever the turn is doing — never into a prompt (409).
func (s *Server) handleQueueSendNow(w http.ResponseWriter, r *http.Request) {
	q, ok := s.queuer(w)
	if !ok {
		return
	}
	id, ok := queuedID(w, r)
	if !ok {
		return
	}
	v, err := q.SendNow(r.Context(), r.PathValue("id"), id)
	if err != nil {
		s.queueFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}
