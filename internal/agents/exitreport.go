package agents

import (
	"context"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/termbuf"
)

// EarlyExit is how soon after its start a session's program may end, with
// nothing typed into it, for the end to read as "it exited at once": a
// program that could not start (a flag it refused, a conversation it could
// not find), not one somebody used and closed.
var EarlyExit = 15 * time.Second

// Bounds on what is kept of the screen an ended session left.
const (
	// exitTailBytes is how much of the end of its output is read.
	exitTailBytes = 32 << 10
	// exitTailLines and exitTailMax bound the text kept from it.
	exitTailLines = 40
	exitTailMax   = 4 << 10
	// exitReportsKept is how many ended sessions this manager remembers
	// (with their launch, for Try again); older ones are read from the store.
	exitReportsKept = 64
)

// ExitReport is how an owned session's program ended: its code, how long it
// ran, and the last lines its terminal showed. Served by GET
// /v1/agents/{id}/exit; the tab of a session that exited at once shows it
// in place of a terminal that can no longer connect.
type ExitReport struct {
	SessionID string `json:"session_id"`
	// Agent is which coding agent it was ("claude", "codex", …); "" when
	// only the store remembers the exit.
	Agent string `json:"agent,omitempty"`
	Code  int    `json:"code"`
	// Early: it ended within EarlyExit of its start with nothing typed.
	Early bool `json:"early"`
	// Freed: Caprock ended it to free memory, on the user's click; its
	// conversation is kept and can be continued.
	Freed bool  `json:"freed,omitempty"`
	RanMs int64 `json:"ran_ms"`
	// Tail is the end of what it printed, as plain text: the screen it left,
	// ANSI and blank lines stripped, at most exitTailLines lines.
	Tail string `json:"tail"`
	// At is when it ended, unix ms.
	At int64 `json:"at"`
	// Retry is the request that started it, for Try again: the same launch
	// once more, which for a fork or a fresh session is a new session id. Only
	// what a request body may carry is in it (the keys and directories the
	// daemon fills in are not JSON fields). Absent when this daemon did not
	// start it.
	Retry *SpawnRequest `json:"retry,omitempty"`
	// Binary is the program that ran, as resolved in the daemon's
	// environment; absent when only the store remembers the exit.
	Binary string `json:"binary,omitempty"`
}

// screenTail is the text an output's end leaves on a cols-wide screen: the
// bytes replayed (termbuf.Screen places the cursor the way the program
// did), blank lines dropped at both ends, the last exitTailLines lines,
// cut to exitTailMax bytes from the end.
func screenTail(out []byte, cols int) string {
	if len(out) > exitTailBytes {
		out = out[len(out)-exitTailBytes:]
	}
	if cols <= 0 || cols > 300 {
		cols = 120
	}
	rows := termbuf.Screen(out, cols, 60)
	for len(rows) > 0 && strings.TrimSpace(rows[len(rows)-1]) == "" {
		rows = rows[:len(rows)-1]
	}
	for len(rows) > 0 && strings.TrimSpace(rows[0]) == "" {
		rows = rows[1:]
	}
	if len(rows) > exitTailLines {
		rows = rows[len(rows)-exitTailLines:]
	}
	s := strings.Join(rows, "\n")
	if len(s) > exitTailMax {
		s = s[len(s)-exitTailMax:]
		for len(s) > 0 && !utf8.RuneStart(s[0]) {
			s = s[1:]
		}
	}
	return s
}

// recordExit keeps how a just-ended session ended: in memory, with its
// launch, and in the store (session_exits), and on an early exit in the
// log at WARN with the command it ran — the line that used to say only
// "exit status 1".
func (m *Manager) recordExit(a *Agent, code int, at time.Time) ExitReport {
	cols, _ := a.size()
	ran := at.Sub(a.StartedAt)
	rep := ExitReport{
		SessionID: a.SessionID, Agent: a.Kind, Code: code, RanMs: ran.Milliseconds(), At: at.UnixMilli(),
		Early: ran < EarlyExit && !a.typedAny.Load() && !a.stopped.Load() && !m.Restarting(a.SessionID),
		Freed: a.freed.Load(),
		Tail:  screenTail(a.ring.snapshot(), cols),
		Retry: a.retry, Binary: a.argv0,
	}
	m.mu.Lock()
	if m.exits == nil {
		m.exits = map[string]ExitReport{}
	}
	m.exits[a.SessionID] = rep
	m.exitOrder = append(m.exitOrder, a.SessionID)
	for len(m.exitOrder) > exitReportsKept {
		old := m.exitOrder[0]
		m.exitOrder = m.exitOrder[1:]
		if r, ok := m.exits[old]; ok && r.At <= rep.At && old != a.SessionID {
			delete(m.exits, old)
		}
	}
	m.mu.Unlock()
	if m.store != nil {
		_ = m.store.WithTx(context.Background(), func(q store.Querier) error {
			return store.RecordExit(context.Background(), q, store.SessionExit{
				SessionID: rep.SessionID, Code: rep.Code, RanMs: rep.RanMs, Early: rep.Early, Tail: rep.Tail, At: rep.At,
			})
		})
	}
	if rep.Early && a.Kind != KindShell {
		// Which binary ran, and its version: the daemon's environment is
		// launchd's, not the user's shell, and an older claude found first
		// refuses a flag the newer one has. The version is the cached one;
		// when none is cached it is asked off this goroutine and logged on a
		// line of its own.
		ver := m.binVersions.get(a.argv0, false)
		m.log.Warn("owned session exited at once", "component", "agents", "session_id", a.SessionID,
			"code", code, "ran_ms", rep.RanMs, "binary", a.argv0, "version", ver,
			"command", redactArgs(a.argv0, a.argv), "output", rep.Tail)
		if ver == "" {
			go func(id, bin string) {
				if v := m.binVersions.get(bin, true); v != "" {
					m.log.Warn("the agent that exited at once", "component", "agents", "session_id", id, "binary", bin, "version", v)
				}
			}(a.SessionID, a.argv0)
		}
	}
	return rep
}

// Exit is how an owned session ended: from memory while this daemon
// remembers it, else from the store. ok is false for a session still
// running, and for one no exit was ever recorded for.
func (m *Manager) Exit(sessionID string) (ExitReport, bool) {
	m.mu.Lock()
	rep, ok := m.exits[sessionID]
	m.mu.Unlock()
	if ok {
		return rep, true
	}
	if m.store == nil {
		return ExitReport{}, false
	}
	e, ok, err := store.GetExit(context.Background(), m.store.DB(), sessionID)
	if err != nil || !ok {
		return ExitReport{}, false
	}
	rep = ExitReport{SessionID: e.SessionID, Code: e.Code, Early: e.Early, RanMs: e.RanMs, Tail: e.Tail, At: e.At}
	if s, err := store.GetSession(context.Background(), m.store.DB(), sessionID); err == nil {
		rep.Agent = s.Agent
	}
	return rep, true
}

// forgetExit drops a remembered exit: the id runs again (a restart into
// another mode, a resume under its own id).
func (m *Manager) forgetExitLocked(sessionID string) { delete(m.exits, sessionID) }

// retryOf is the request to keep for Try again: the launch as it was, in
// the folder it ran in, with a worktree already made not made again.
func retryOf(req SpawnRequest, cwd string) *SpawnRequest {
	r := req
	r.Cwd = cwd
	r.Create = false
	r.Worktree, r.WorktreeBase, r.WorktreePull, r.WorktreePR = "", "", false, 0
	r.NativeResume, r.GeminiKey, r.DeepSeekKey, r.ConfigDir = "", "", "", ""
	return &r
}

// valueFlags are the flags whose next argument is the user's words or the
// project's instructions, logged as their length only.
var valueFlags = map[string]bool{"--append-system-prompt": true, "--system-prompt": true, "-c": true, "--config": true, "--prompt": true, "-p": true, "-i": true}

// redactArgs is an argv for the log: the program and its flags as they
// are, the values of valueFlags and anything that reads as text rather than
// a flag, an id or a path (a first message, passed as the positional
// prompt) cut to their length, and anything key- or token-shaped dropped.
func redactArgs(command string, args []string) string {
	out := []string{command}
	for i := 0; i < len(args); i++ {
		a := args[i]
		low := strings.ToLower(a)
		switch {
		case strings.Contains(low, "key=") || strings.Contains(low, "token=") || strings.HasPrefix(low, "sk-"):
			out = append(out, "[redacted]")
		case valueFlags[a] && i+1 < len(args):
			out = append(out, a, textLen(args[i+1]))
			i++
		case !strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "/") && (len(a) > 80 || strings.ContainsAny(a, " \n\t")):
			out = append(out, textLen(a))
		default:
			out = append(out, a)
		}
	}
	return strings.Join(out, " ")
}

func textLen(s string) string { return "[" + strconv.Itoa(utf8.RuneCountInString(s)) + " chars]" }
