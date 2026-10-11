package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/dspv/caprock/internal/store"
)

// The Queue view (03-contracts.md § Queue): across the sessions Caprock
// started, what each is doing now, what waits in its message queue with a
// rough estimate of when it starts and is done, and the turns finished in the
// last hours. Read-only: adding goes through POST /v1/agents/{id}/queue.

// QueueBoard is GET /v1/queue.
type QueueBoard struct {
	// Now is the daemon's clock (unix ms) when the board was read; every
	// estimate counts from it.
	Now      int64          `json:"now"`
	Sessions []BoardSession `json:"sessions"`
	// Done is the turns of sessions Caprock started that ended at or after
	// DoneSince, newest first.
	Done      []BoardDone `json:"done"`
	DoneSince int64       `json:"done_since"`
}

// BoardSession is one session Caprock started and still runs.
type BoardSession struct {
	SessionID string `json:"session_id"`
	Agent     string `json:"agent"`
	Title     string `json:"title,omitempty"`
	Project   string `json:"project,omitempty"`
	// Dir is the project the estimate groups by: the repository root, else
	// the folder.
	Dir    string `json:"dir,omitempty"`
	Branch string `json:"branch,omitempty"`
	// Waiting is the queue's own: "turn", "permission", "question", or ""
	// at its prompt (§ Queued messages).
	Waiting string `json:"waiting"`
	// TurnStartedAt is when the running turn's prompt was sent, unix ms; 0
	// when none runs or it is not known.
	TurnStartedAt int64      `json:"turn_started_at,omitempty"`
	Todo          *BoardTodo `json:"todo,omitempty"`
	// Queue is the session's queued messages, oldest first, each with its
	// place and estimate.
	Queue []BoardItem `json:"queue"`
	// TurnLeft is the running turn's remaining time; absent without an
	// estimate or a running turn.
	TurnLeft *ETA `json:"turn_left,omitempty"`
	// FreeIn is when a message added now would start: 0 at the prompt with
	// nothing queued; absent when it cannot be estimated.
	FreeIn   *ETA      `json:"free_in,omitempty"`
	Estimate *Estimate `json:"estimate,omitempty"`
	// EstimateNote says why there is no estimate, when there is none.
	EstimateNote string `json:"estimate_note,omitempty"`
}

// BoardTodo is the agent's own task list, summed up.
type BoardTodo struct {
	// Active is the in-progress item's active form, else its text.
	Active string `json:"active,omitempty"`
	Done   int    `json:"done"`
	Total  int    `json:"total"`
}

// BoardItem is one queued message.
type BoardItem struct {
	store.QueuedMessage
	// Position is 1 for the message typed in when the current turn ends.
	Position int  `json:"position"`
	Start    *ETA `json:"start,omitempty"`
	Finish   *ETA `json:"finish,omitempty"`
}

// ETA is an estimate in milliseconds from Now: the median and the
// 25th–75th percentile range.
type ETA struct {
	LoMs  int64 `json:"lo_ms"`
	MidMs int64 `json:"mid_ms"`
	HiMs  int64 `json:"hi_ms"`
}

// Estimate is what the estimates are made from: the project's newest
// finished Claude Code turns.
type Estimate struct {
	Turns    int   `json:"turns"`
	P25Ms    int64 `json:"p25_ms"`
	MedianMs int64 `json:"median_ms"`
	P75Ms    int64 `json:"p75_ms"`
}

// BoardDone is one finished turn.
type BoardDone struct {
	SessionID string `json:"session_id"`
	Agent     string `json:"agent"`
	Title     string `json:"title,omitempty"`
	Project   string `json:"project,omitempty"`
	Prompt    string `json:"prompt"`
	StartedAt int64  `json:"started_at"`
	EndedAt   int64  `json:"ended_at"`
	// Queued: the prompt was a queued message Caprock typed in.
	Queued bool `json:"queued,omitempty"`
	// Failed: the turn ended on a StopFailure (a limit, an overload).
	Failed bool `json:"failed,omitempty"`
}

// QueueBoarder assembles the board. Optional on Deps: nil answers 501.
type QueueBoarder interface {
	Board(ctx context.Context) (QueueBoard, error)
}

// handleQueueBoard is GET /v1/queue.
func (s *Server) handleQueueBoard(w http.ResponseWriter, r *http.Request) {
	if s.d.Board == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this daemon has no queue board"))
		return
	}
	b, err := s.d.Board.Board(r.Context())
	if err != nil {
		s.failCode(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, b)
}
