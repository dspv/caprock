package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/nativeterm"
	"github.com/dspv/caprock/internal/store"
)

// TerminalController finds the user's own terminal applications and opens a
// command in one (internal/nativeterm). nil ⇒ the endpoints answer 501.
type TerminalController interface {
	// List is the installed terminals, most preferred first, and the id of
	// the one a button opens when none is named.
	List() (terminals []nativeterm.Terminal, preferred string)
	// Open runs argv in cwd in the terminal with this id ("" for the
	// preferred one). before runs once the launch is planned and before it
	// starts — so a refusal (no such terminal, an unsafe folder name) is
	// known before anything is stopped for it.
	Open(ctx context.Context, terminal, cwd string, argv []string, before func() error) (nativeterm.Terminal, string, error)
}

// Open-in-terminal modes.
const (
	// OpenResume carries an ended session on in the user's terminal.
	OpenResume = "resume"
	// OpenMove stops Caprock's own process for the session, then resumes the
	// same conversation in the user's terminal.
	OpenMove = "move"
	// OpenFork branches a live session into the user's terminal under a new
	// id; the original keeps running where it is.
	OpenFork = "fork"
)

// OpenTerminalInfo says how a session can be opened in the user's own
// terminal: the modes allowed, the first being what the main button does,
// and the reason when there is none or a mode is missing.
type OpenTerminalInfo struct {
	Modes  []string `json:"modes"`
	Reason string   `json:"reason,omitempty"`
}

// openTerminalModes is the ownership rule, on its own so it can be read and
// tested as a table (CLAUDE.md rule 7: nothing is signalled or typed into
// unless Caprock started it).
//
//   - Ended: resume it. One conversation, carried on.
//   - Running, started by Caprock, and this daemon holds its terminal: the
//     process is Caprock's to stop, so it can be moved — stopped here, then
//     resumed there — or, for Claude Code, forked and left running.
//   - Running anywhere else (the user's own terminal, or a Caprock session
//     whose terminal went with a restart): Caprock may not stop it, and two
//     processes appending to one conversation interleave their turns. So it
//     can only be forked, which only Claude Code does without a copy of the
//     history Caprock would count twice.
func openTerminalModes(agent string, ended, owned, held bool) ([]string, string) {
	forks := agent == "" || agent == agents.AgentClaude
	switch {
	case ended:
		return []string{OpenResume}, ""
	case owned && held:
		if forks {
			return []string{OpenMove, OpenFork}, ""
		}
		return []string{OpenMove}, ""
	case forks:
		return []string{OpenFork}, "It is still running in a terminal Caprock does not hold, so it can only be branched."
	case owned:
		return nil, "It is still running, and Caprock no longer holds its terminal. Open it once it has ended."
	default:
		return nil, "It is still running in another terminal. Open it once it has ended."
	}
}

// openTerminalInfo is nil when the agent has no command that reopens a
// session by id (Gemini), so no button is shown at all.
func (s *Server) openTerminalInfo(sess store.Session) *OpenTerminalInfo {
	if s.d.Terminals == nil {
		return nil
	}
	if _, err := agents.NativeResume(sess.Agent, nativeID(sess), false); err != nil {
		return nil
	}
	ended := sess.Status == store.StatusEnded
	held := s.d.Agents != nil && s.d.Agents.Holds(sess.SessionID)
	modes, reason := openTerminalModes(sess.Agent, ended, sess.Owned, held)
	info := &OpenTerminalInfo{Modes: modes, Reason: reason}
	if info.Modes == nil {
		info.Modes = []string{}
	}
	if (sess.Agent == "" || sess.Agent == agents.AgentClaude) && ended && !transcriptOnDisk(sess) {
		// `claude --resume` reads this file; without it the new window
		// prints "No conversation found" and the user is left in a shell.
		info.Modes = []string{}
		info.Reason = "Claude Code has deleted its transcript (it keeps them 30 days by default, see cleanupPeriodDays)."
	}
	if (sess.Agent == agents.AgentCodex || sess.Agent == agents.AgentOpenCode) && sess.Owned && sess.NativeID == "" {
		// Started here and never linked: nothing was sent, so the agent never
		// made a thread or a session to go back to (the same answer resume
		// gives).
		info.Modes = []string{}
		info.Reason = "Nothing was sent in this session, so " + agentLabel(sess.Agent) + " has nothing to continue."
	}
	if sess.Agent == agents.AgentOpenCode && sess.Cwd != "" && !isDir(sess.Cwd) {
		info.Modes = []string{}
		info.Reason = "The folder it ran in no longer exists: " + sess.Cwd
	}
	return info
}

// nativeID is the agent's own id for a session — what its resume flag takes:
// the linked id for a Codex or OpenCode session Caprock started
// (sessions.native_id), the session id for everything else.
func nativeID(sess store.Session) string {
	if sess.NativeID != "" {
		return sess.NativeID
	}
	return sess.SessionID
}

func agentLabel(agent string) string {
	if agent == agents.AgentOpenCode {
		return "OpenCode"
	}
	return "Codex"
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func (s *Server) handleTerminals(w http.ResponseWriter, _ *http.Request) {
	if s.d.Terminals == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("opening a terminal is not available"))
		return
	}
	ts, preferred := s.d.Terminals.List()
	if ts == nil {
		ts = []nativeterm.Terminal{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"terminals": ts, "preferred": preferred})
}

// handleOpenTerminal opens a session in the user's own terminal application.
//
// Caprock goes on watching it the way it watches any session somebody started
// themselves — hooks and the transcript — so cost, answers and alerts carry
// on; only the window it is typed into changes.
func (s *Server) handleOpenTerminal(w http.ResponseWriter, r *http.Request) {
	if s.d.Terminals == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("opening a terminal is not available"))
		return
	}
	var body struct {
		Terminal string `json:"terminal"`
		Mode     string `json:"mode"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	switch body.Mode {
	case "", OpenResume, OpenMove, OpenFork:
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `mode must be "resume", "move" or "fork"`})
		return
	}
	id := r.PathValue("id")
	sess, err := store.GetSession(r.Context(), s.d.Store.DB(), id)
	if err != nil {
		s.notFoundOrFail(w, err)
		return
	}
	info := s.openTerminalInfo(sess)
	if info == nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "This agent cannot reopen a session by its id, so there is no command to run."})
		return
	}
	mode := body.Mode
	if mode == "" && len(info.Modes) > 0 {
		mode = info.Modes[0]
	}
	if !contains(info.Modes, mode) {
		reason := info.Reason
		if reason == "" {
			reason = "That is not possible for this session now; it may have started or ended since the page loaded."
		}
		writeJSON(w, http.StatusConflict, map[string]string{"error": reason})
		return
	}
	argv, err := agents.NativeResume(sess.Agent, nativeID(sess), mode == OpenFork)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	cwd := sess.Cwd
	if cwd != "" && !isDir(cwd) {
		// Claude Code and Codex find a conversation by id from any folder;
		// a `cd` into a folder that is gone would stop the line before it.
		cwd = ""
	}
	var before func() error
	if mode == OpenMove {
		before = func() error { return s.release(r.Context(), sess.SessionID) }
	}
	term, command, err := s.d.Terminals.Open(r.Context(), body.Terminal, cwd, argv, before)
	if err != nil {
		code := http.StatusBadGateway
		if errors.Is(err, nativeterm.ErrUnsafe) || errors.Is(err, nativeterm.ErrNoTerminal) {
			code = http.StatusBadRequest
		}
		if errors.Is(err, errStillRunning) {
			code = http.StatusConflict
		}
		writeJSON(w, code, map[string]string{"error": err.Error(), "command": command})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"terminal": term, "mode": mode, "command": command})
}

var errStillRunning = errors.New("caprock asked its process for this session to stop and it is still running; try again in a moment")

// release stops Caprock's own process for a session and hands the session
// over: it is no longer Caprock's, so it is not shown as one Caprock lost the
// terminal of once the user's own terminal picks it up.
//
// Only a session this daemon holds gets here (openTerminalModes), and the
// manager refuses any other — rule 7 is enforced where the process handles
// are, not only by this caller.
func (s *Server) release(ctx context.Context, id string) error {
	if s.d.Agents == nil {
		return errStillRunning
	}
	// A paused process cannot act on a signal; let it run first.
	_ = s.d.Agents.Signal(id, "resume")
	if err := s.d.Agents.Signal(id, "term"); err != nil {
		return err
	}
	if !s.waitReleased(id, agents.ShutdownGrace) {
		// It had its chance to write its transcript out; two processes on
		// one conversation would be worse than a hard stop.
		_ = s.d.Agents.Signal(id, "kill")
		if !s.waitReleased(id, 2*time.Second) {
			return errStillRunning
		}
	}
	return store.ReleaseOwned(ctx, s.d.Store.DB(), id)
}

func (s *Server) waitReleased(id string, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for s.d.Agents.Holds(id) {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
	return true
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
