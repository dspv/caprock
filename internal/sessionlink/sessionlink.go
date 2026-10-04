// Package sessionlink joins a session Caprock started to the record the
// agent's own files keep of it.
//
// Claude Code and Gemini CLI take an id on the command line, so the session
// Caprock starts and the session their transcript or telemetry describes are
// one id from the first byte. Codex and OpenCode cannot be told one. Codex
// names its thread itself; OpenCode creates its session when the first message
// is sent. Their importers find those sessions under the agent's own id, and
// without a link a session started from the dashboard would appear twice —
// once as a terminal with no cost, once as a cost with no terminal.
//
// A link is made one of two ways, and the difference is the whole point of
// keeping them apart:
//
//   - Claim is exact. OpenCode's TUI runs a server on a port Caprock chose,
//     and that server announces `session.created` for the session the TUI
//     made. Nothing else can be on that port.
//   - Match is a heuristic, for Codex, which writes no id anywhere Caprock can
//     see before the rollout appears. A rollout is matched to a spawn when it
//     was written by the Codex TUI (not the desktop app, not a subagent, not an
//     import), in the same directory, by a thread that started within the
//     window after the spawn. Codex stamps a thread with the moment the TUI
//     started, not the moment its file was first written (measured on 14 CLI
//     rollouts: up to 4m40s apart), so the window can be tight even though the
//     file appears whenever the user first types.
//
// Once made, a link is stored on the session (sessions.native_id) and the
// importers write the thread's events under Caprock's id.
package sessionlink

import (
	"context"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// Window is how long after a spawn a Codex thread may say it started and still
// be taken as the one Caprock launched. The TUI stamps its thread within
// seconds of starting; two minutes covers a loaded machine without reaching a
// thread the user opened later by hand.
const Window = 2 * time.Minute

// Skew is how far before the spawn a thread's start may be stamped. Clocks
// agree on one machine; this absorbs rounding, not drift.
const Skew = 5 * time.Second

// Grace is how long an expectation outlives the process that set it. A
// session that is typed into and closed within one import tick still has its
// rollout read after it has gone.
const Grace = time.Minute

// Candidate is a session an importer found under the agent's own id.
type Candidate struct {
	NativeID string
	Cwd      string
	Started  time.Time
	// Eligible says the session is one a person started in the agent's own
	// TUI — not a subagent, a thread imported from another agent, or one the
	// desktop app owns. Only an eligible candidate is ever matched.
	Eligible bool
}

type pending struct {
	agent     string
	sessionID string
	cwd       []string // as given, and with symlinks resolved
	at        time.Time
	match     bool      // Match may take it (Codex); Claim only otherwise
	endedAt   time.Time // zero while the process runs
}

// Linker holds the spawns still waiting for their agent's id.
type Linker struct {
	Store *store.Store
	Log   *slog.Logger
	// Now is overridable in tests.
	Now func() time.Time

	mu      sync.Mutex
	pending []pending
	known   map[string]string // agent + "\x00" + native id → session id
}

// New builds a linker over the store.
func New(st *store.Store, log *slog.Logger) *Linker {
	if log == nil {
		log = slog.Default()
	}
	return &Linker{Store: st, Log: log, Now: time.Now, known: map[string]string{}}
}

func (l *Linker) now() time.Time {
	if l.Now != nil {
		return l.Now()
	}
	return time.Now()
}

// Expect records a spawn whose agent will name the session later. match says
// whether Match may take it; OpenCode's spawns are claimed exactly instead.
func (l *Linker) Expect(agent, sessionID, cwd string, at time.Time, match bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.pending = append(l.pending, pending{agent: agent, sessionID: sessionID, cwd: dirs(cwd), at: at, match: match})
}

// Ended tells the linker a spawned process has exited. Its expectation is kept
// for Grace, then dropped.
func (l *Linker) Ended(sessionID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := range l.pending {
		if l.pending[i].sessionID == sessionID && l.pending[i].endedAt.IsZero() {
			l.pending[i].endedAt = l.now()
		}
	}
}

// Waiting reports whether any spawn of this agent is still unlinked — an
// importer uses it to hold back a file it could otherwise only file under the
// wrong id.
func (l *Linker) Waiting(agent string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.expireLocked()
	for _, p := range l.pending {
		if p.agent == agent {
			return true
		}
	}
	return false
}

func (l *Linker) expireLocked() {
	now := l.now()
	out := l.pending[:0]
	for _, p := range l.pending {
		if !p.endedAt.IsZero() && now.Sub(p.endedAt) > Grace {
			continue
		}
		out = append(out, p)
	}
	l.pending = out
}

// Claim links sessionID to the agent's own id, exactly. It is for a source
// that names the session it made — OpenCode's own server on a port Caprock
// chose. Reports whether the link was made.
func (l *Linker) Claim(ctx context.Context, agent, sessionID, nativeID string) bool {
	if l == nil || l.Store == nil || nativeID == "" {
		return false
	}
	ok, err := store.SetNativeID(ctx, l.Store.DB(), sessionID, nativeID)
	if err != nil {
		l.Log.Warn("could not link a spawned session to its agent's id", "component", "sessionlink",
			"agent", agent, "session_id", sessionID, "native_id", nativeID, "err", err)
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for i, p := range l.pending {
		if p.sessionID == sessionID {
			l.pending = append(l.pending[:i], l.pending[i+1:]...)
			break
		}
	}
	if ok {
		l.known[agent+"\x00"+nativeID] = sessionID
		l.Log.Info("linked a spawned session to its agent's id", "component", "sessionlink",
			"agent", agent, "session_id", sessionID, "native_id", nativeID, "exact", true)
	}
	return ok
}

// Resolve answers the id an importer should store a session's events under:
// the Caprock session linked to it, or the agent's own id when there is none.
// A candidate that matches a waiting Codex spawn is linked here.
func (l *Linker) Resolve(ctx context.Context, agent string, c Candidate) string {
	if l == nil || l.Store == nil || c.NativeID == "" {
		return c.NativeID
	}
	key := agent + "\x00" + c.NativeID
	l.mu.Lock()
	if id, ok := l.known[key]; ok {
		l.mu.Unlock()
		return id
	}
	l.mu.Unlock()

	db := l.Store.DB()
	if id, err := store.SessionForNative(ctx, db, agent, c.NativeID); err == nil && id != "" {
		l.mu.Lock()
		l.known[key] = id
		l.mu.Unlock()
		return id
	}
	if !c.Eligible {
		return c.NativeID
	}

	l.mu.Lock()
	l.expireLocked()
	best := -1
	for i, p := range l.pending {
		if !p.match || p.agent != agent || !sameDir(p.cwd, c.Cwd) {
			continue
		}
		if c.Started.Before(p.at.Add(-Skew)) || c.Started.After(p.at.Add(Window)) {
			continue
		}
		// Two spawns in one folder inside the window: the thread goes to the
		// spawn that started closest before it.
		if best < 0 || absDur(c.Started.Sub(p.at)) < absDur(c.Started.Sub(l.pending[best].at)) {
			best = i
		}
	}
	if best < 0 {
		l.mu.Unlock()
		return c.NativeID
	}
	p := l.pending[best]
	l.mu.Unlock()

	// A thread the store already knows under its own id was there before this
	// spawn — a resumed one, or one read on an earlier pass — and is not ours.
	if _, err := store.GetSession(ctx, db, c.NativeID); err == nil {
		return c.NativeID
	}
	ok, err := store.SetNativeID(ctx, db, p.sessionID, c.NativeID)
	if err != nil || !ok {
		if err != nil {
			l.Log.Warn("could not link a spawned session to its agent's id", "component", "sessionlink",
				"agent", agent, "session_id", p.sessionID, "native_id", c.NativeID, "err", err)
		}
		return c.NativeID
	}
	l.mu.Lock()
	for i := range l.pending {
		if l.pending[i].sessionID == p.sessionID {
			l.pending = append(l.pending[:i], l.pending[i+1:]...)
			break
		}
	}
	l.known[key] = p.sessionID
	l.mu.Unlock()
	l.Log.Info("linked a spawned session to its agent's id", "component", "sessionlink",
		"agent", agent, "session_id", p.sessionID, "native_id", c.NativeID, "exact", false,
		"started_after_spawn", c.Started.Sub(p.at).String())
	return p.sessionID
}

// dirs is a directory as given and as resolved, so a spawn in /tmp/x matches
// an agent that recorded /private/tmp/x.
func dirs(cwd string) []string {
	out := []string{filepath.Clean(cwd)}
	if real, err := filepath.EvalSymlinks(cwd); err == nil {
		if real = filepath.Clean(real); real != out[0] {
			out = append(out, real)
		}
	}
	return out
}

func sameDir(want []string, got string) bool {
	if got == "" {
		return false
	}
	for _, g := range dirs(got) {
		for _, w := range want {
			if samePath(w, g) {
				return true
			}
		}
	}
	return false
}

func absDur(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}
