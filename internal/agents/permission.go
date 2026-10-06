package agents

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/store"
)

// A permission prompt an owned Claude Code session is waiting on, and the
// buttons that answer it (ADR-035).
//
// **Detected from Claude Code's own PermissionRequest hook, not from the
// screen.** The hook fires the moment the dialog is drawn and carries the tool,
// its input and what "don't ask again" would add. The screen carries the same
// facts as cursor moves between words (Ink writes `Do\x1b[5Gyou\x1b[9Gwant`),
// which a parser would have to emulate a terminal to read, and which changes
// with every release.
//
// **Answered with the keys a person would press**, measured on Claude Code
// 2.1.289: `1` picks "Yes" at once, `2` picks the second option — the one the
// hook's permission_suggestions describe ("don't ask again for: python3 *",
// "allow all edits this session") — and Esc is "No". The hook's own decision
// output is not used: it has to be printed before the hook exits, and the shim
// exits within a second (rule 3), long before anyone has looked at a phone.
//
// **Cleared by whatever answers it**: a button here, a key typed into the
// terminal that answers a menu (Enter, Esc, a digit, Ctrl+C), the tool's own
// PostToolUse, the next prompt or Stop, or the session ending. Arrow keys do
// not clear it — moving through the menu is not answering it.

// Permission is the prompt an owned session is showing.
type Permission struct {
	// ID names this prompt, so a button drawn for one prompt cannot answer
	// the next.
	ID string `json:"id"`
	// Tool is the tool being asked about ("Bash", "Write", "mcp__…").
	Tool string `json:"tool"`
	// Detail is what it would do: the command, the file, the URL.
	Detail string `json:"detail"`
	// Always labels the second option when Claude Code offers one ("Yes, and
	// don't ask again"); empty when the button is not offered.
	Always string    `json:"always,omitempty"`
	Since  time.Time `json:"since"`

	// input is the tool input, compacted, to recognise the PostToolUse that
	// shows the prompt was answered in the terminal.
	input string
}

// PermissionChoice is one of the answers a button gives.
type PermissionChoice string

// The answers, and the key each one presses.
const (
	PermissionAllow  PermissionChoice = "allow"
	PermissionAlways PermissionChoice = "always"
	PermissionDeny   PermissionChoice = "deny"
)

var permissionKeys = map[PermissionChoice]string{
	PermissionAllow:  "1",
	PermissionAlways: "2",
	PermissionDeny:   "\x1b",
}

// ErrNoPermission means the session is not waiting on the prompt named: it
// was answered, replaced, or never asked.
var ErrNoPermission = errors.New("the session is not waiting on that permission prompt")

// ErrNoAlways means the prompt has no "don't ask again" option to pick.
var ErrNoAlways = errors.New("this prompt has no \"don't ask again\" option")

// HookSignal is the part of a hook payload that sets or clears a prompt.
type HookSignal struct {
	SessionID string
	Event     string // hook_event_name
	AgentID   string // set inside a subagent
	Tool      string
	Input     json.RawMessage
	// Suggestions is PermissionRequest's permission_suggestions, verbatim.
	Suggestions json.RawMessage
}

// detailMax caps Detail; a heredoc can be pages long, and the phone shows the
// start of it.
const detailMax = 2000

// ObserveHook updates the prompt an owned session is waiting on from one of
// its hook events. Sessions this manager did not start are ignored: there is
// nothing here that could answer them (rule 7).
func (m *Manager) ObserveHook(sig HookSignal) {
	if _, ok := m.Get(sig.SessionID); !ok {
		return
	}
	switch sig.Event {
	case "PermissionRequest":
		if p := newPermission(sig); p != nil {
			m.setPermission(sig.SessionID, p)
		}
	case "PostToolUse":
		m.permMu.Lock()
		p := m.perms[sig.SessionID]
		m.permMu.Unlock()
		if p != nil && p.Tool == sig.Tool && p.input == compactJSON(sig.Input) {
			m.clearPermission(sig.SessionID)
		}
	case "UserPromptSubmit", "Stop":
		if sig.AgentID == "" {
			m.clearPermission(sig.SessionID)
		}
	case "SessionEnd":
		m.clearPermission(sig.SessionID)
	}
}

// newPermission builds the prompt a PermissionRequest describes, or nil for a
// dialog the buttons would answer wrongly: AskUserQuestion's options are the
// question's answers, not Yes and No.
func newPermission(sig HookSignal) *Permission {
	if sig.Tool == "AskUserQuestion" {
		return nil
	}
	var id [6]byte
	_, _ = rand.Read(id[:])
	return &Permission{
		ID:     hex.EncodeToString(id[:]),
		Tool:   sig.Tool,
		Detail: describeToolInput(sig.Input),
		Always: alwaysLabel(sig.Tool, sig.Suggestions),
		Since:  time.Now().UTC(),
		input:  compactJSON(sig.Input),
	}
}

// PendingPermission returns the prompt an owned session is waiting on.
func (m *Manager) PendingPermission(sessionID string) (*Permission, bool) {
	if _, ok := m.Get(sessionID); !ok {
		return nil, false
	}
	m.permMu.Lock()
	defer m.permMu.Unlock()
	p, ok := m.perms[sessionID]
	if !ok {
		return nil, false
	}
	cp := *p
	return &cp, true
}

// AnswerPermission presses the key for choice in an owned session's
// permission prompt, if it is still the prompt named id.
func (m *Manager) AnswerPermission(sessionID, id string, choice PermissionChoice) error {
	a, ok := m.Get(sessionID)
	if !ok {
		return errNotOwned(sessionID)
	}
	key, ok := permissionKeys[choice]
	if !ok {
		return fmt.Errorf("unknown choice %q", choice)
	}
	m.permMu.Lock()
	p := m.perms[sessionID]
	if p == nil || p.ID != id {
		m.permMu.Unlock()
		return ErrNoPermission
	}
	if choice == PermissionAlways && p.Always == "" {
		m.permMu.Unlock()
		return ErrNoAlways
	}
	delete(m.perms, sessionID)
	m.permMu.Unlock()
	m.notifyPermission(sessionID, nil)
	_, err := a.sess.Write([]byte(key))
	m.persistLater(sessionID)
	return err
}

// answersAMenu reports whether typed bytes answer a menu rather than move
// through it: Enter, a bare Esc, Ctrl+C, or a single digit.
func answersAMenu(data []byte) bool {
	if len(data) != 1 {
		return false
	}
	c := data[0]
	return c == '\r' || c == '\n' || c == 0x1b || c == 0x03 || (c >= '0' && c <= '9')
}

// setPermission stores a new prompt and then shows it, on the hook's own
// goroutine: the row is committed before the hook is answered and before any
// button can be drawn for it. Written later, a daemon killed in the moment
// after the hook returned — a crash, a Windows stop, which has no SIGTERM and
// so no Shutdown to wait for the write — came back without the dialog that
// was still on the session's screen. The hook's own event is written on this
// goroutine too, so this adds one small write to a request that already
// waits on the database (hookd.RecordTimeout), not a new kind of wait.
//
// Clearing stays off the caller's goroutine (persistLater): a keystroke must
// not wait on the database, and a clear lost to a crash is caught on restore
// by the events that say the session moved on.
func (m *Manager) setPermission(sessionID string, p *Permission) {
	m.persistMu.Lock()
	m.writePermission(sessionID, p)
	m.permMu.Lock()
	if m.perms == nil {
		m.perms = map[string]*Permission{}
	}
	m.perms[sessionID] = p
	m.permMu.Unlock()
	m.persistMu.Unlock()
	cp := *p
	m.notifyPermission(sessionID, &cp)
}

func (m *Manager) clearPermission(sessionID string) {
	m.permMu.Lock()
	_, had := m.perms[sessionID]
	delete(m.perms, sessionID)
	m.permMu.Unlock()
	if had {
		m.notifyPermission(sessionID, nil)
		m.persistLater(sessionID)
	}
}

// persistLater writes a session's prompt — or its absence — to the store off
// the caller's goroutine: a keystroke that answers a menu must not wait on a
// busy database. Used for clears; a new prompt is written in setPermission,
// before the hook that drew it is answered.
func (m *Manager) persistLater(sessionID string) {
	if m.store == nil {
		return
	}
	m.persisting.Add(1)
	go func() {
		defer m.persisting.Done()
		m.persistPermission(sessionID)
	}()
}

// persistPermission makes the stored row match what memory says now, so a
// daemon restart brings the buttons back (migration 0039).
//
// It writes the state current when it runs, not the change that queued it,
// and the writes are serialised: whatever order the goroutines run in, the
// last one to run writes the last state. A stale row is the failure that
// matters — buttons that would press a key into a session no longer asking —
// and restorePermission checks the events as well.
func (m *Manager) persistPermission(sessionID string) {
	m.persistMu.Lock()
	defer m.persistMu.Unlock()
	m.permMu.Lock()
	var cp *Permission
	if p := m.perms[sessionID]; p != nil {
		c := *p
		cp = &c
	}
	m.permMu.Unlock()
	m.writePermission(sessionID, cp)
}

// writePermission makes the stored row say p, or that there is no prompt when
// p is nil. The caller holds persistMu.
func (m *Manager) writePermission(sessionID string, p *Permission) {
	if m.store == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := m.store.WithTx(ctx, func(q store.Querier) error {
		if p == nil {
			return store.ClearPendingPermission(ctx, q, sessionID)
		}
		return store.SavePendingPermission(ctx, q, store.PendingPermission{
			SessionID: sessionID, PromptID: p.ID, Tool: p.Tool, Detail: p.Detail,
			Always: p.Always, SinceMs: p.Since.UnixMilli(), Input: p.input,
		})
	})
	if err != nil {
		m.log.Warn("could not store the permission prompt", "component", "agents", "session_id", sessionID, "err", err)
	}
}

// restorePermission brings back the prompt a reattached session was waiting
// on when the last daemon stopped, unless anything since shows it was
// answered. Called from Reattach, before the API serves anything.
//
// Nobody can type into a held session while no daemon runs, but a hook or a
// transcript line can still say the dialog went away — a write lost at the
// moment the daemon stopped, or a transcript read again on this start. Any
// event after the prompt that means the session moved on drops it: a missing
// button costs a tap in the terminal, a stale one types "1" into a prompt.
func (m *Manager) restorePermission(ctx context.Context, sessionID string) {
	sp, ok, err := store.GetPendingPermission(ctx, m.store.DB(), sessionID)
	if err != nil || !ok {
		return
	}
	moved, err := store.MovedOnSince(ctx, m.store.DB(), sessionID, sp.SinceMs)
	if err != nil || moved {
		_ = m.store.WithTx(ctx, func(q store.Querier) error { return store.ClearPendingPermission(ctx, q, sessionID) })
		return
	}
	m.permMu.Lock()
	if m.perms == nil {
		m.perms = map[string]*Permission{}
	}
	m.perms[sessionID] = &Permission{
		ID: sp.PromptID, Tool: sp.Tool, Detail: sp.Detail, Always: sp.Always,
		Since: time.UnixMilli(sp.SinceMs).UTC(), input: sp.Input,
	}
	m.permMu.Unlock()
	m.log.Info("restored the permission prompt a session was waiting on", "component", "agents", "session_id", sessionID, "tool", sp.Tool)
}

func (m *Manager) notifyPermission(sessionID string, p *Permission) {
	if m.OnPermission != nil {
		m.OnPermission(sessionID, p)
	}
}

// describeToolInput is the one line that says what a tool call would do.
func describeToolInput(input json.RawMessage) string {
	var fields map[string]any
	_ = json.Unmarshal(input, &fields)
	for _, k := range []string{"command", "file_path", "notebook_path", "url", "query", "pattern", "plan"} {
		if s, ok := fields[k].(string); ok && s != "" {
			return clip(s, detailMax)
		}
	}
	return clip(compactJSON(input), detailMax)
}

// alwaysLabel names the second option from the hook's first suggestion, or
// returns "" when there is none — or when it is a kind this code has not seen
// on a real prompt, where "2" might pick something else. ExitPlanMode's
// options are plan approvals, not "don't ask again".
func alwaysLabel(tool string, suggestions json.RawMessage) string {
	if tool == "ExitPlanMode" {
		return ""
	}
	var list []struct {
		Type        string `json:"type"`
		Mode        string `json:"mode"`
		Destination string `json:"destination"`
	}
	if json.Unmarshal(suggestions, &list) != nil || len(list) == 0 {
		return ""
	}
	s := list[0]
	switch s.Type {
	case "setMode":
		if s.Mode == "acceptEdits" {
			return "Yes, allow all edits this session"
		}
	case "addDirectories":
		return "Yes, and allow this folder"
	case "addRules", "replaceRules":
		if s.Destination == "session" {
			return "Yes, for the rest of this session"
		}
		return "Yes, and don’t ask again"
	}
	return ""
}

func compactJSON(raw json.RawMessage) string {
	var b bytes.Buffer
	if json.Compact(&b, raw) != nil {
		return string(raw)
	}
	return b.String()
}

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return strings.TrimRight(string(r[:n]), " ") + "…"
}
