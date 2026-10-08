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

// The permission prompts an owned Claude Code session is waiting on, and the
// buttons that answer them (ADR-035).
//
// **Detected from Claude Code's own PermissionRequest hook.** The hook fires
// the moment a dialog is queued and carries the tool, its input and what
// "don't ask again" would add — the card is drawn from it.
//
// **Queued, not replaced.** Claude Code queues its dialogs — parallel tool
// calls, a subagent's next to the main agent's — and shows the oldest. Each
// PermissionRequest adds a prompt behind the ones waiting; the card shows the
// oldest, which is the dialog on the screen. A later hook used to overwrite
// the earlier prompt, so a card could name one request while its keys landed
// in another's dialog.
//
// **Answered by reading the screen, then pressing the key a person would.**
// The hook says what was asked; only the screen says which menu was drawn,
// and they differ — in auto mode the classifier's dialog is "1. Yes 2. No"
// whatever the suggestions say, so a blind "2" was No. At the moment a button
// is pressed the session's recent output is replayed onto a screen
// (termbuf.Screen), the menu at its bottom is read (permmenu.go), and the key
// is the number of the option whose text is the choice. No menu, or no such
// option, and nothing is typed (ErrNotOnPrompt). Esc is "No", and is sent
// only when a menu is showing: with none, Esc interrupts the turn.
//
// **Cleared by whatever answers it**: a button here, a key typed into the
// terminal that answers a menu (Enter or a digit answers the only one; Esc or
// Ctrl+C rejects and interrupts, and clears them all), the tool's own
// PostToolUse, a subagent's SubagentStop for its prompts, the main thread's
// next prompt or Stop, or the session ending. Arrow keys do not clear it —
// moving through the menu is not answering it.
//
// **One outstanding, or none answered from here** (amended 2026-10-09).
// Subagents running in parallel ask at once, and which of their dialogs the
// terminal shows is not something a hook says: the order the prompts arrived
// in is not the order they are drawn or answered in (the owner's database has
// overlapping prompts finishing in either order). So a button answers only
// while exactly one prompt is outstanding. With two or more, the card lists
// them all and sends the reader to the terminal; Yes, the second option and
// No are refused (ErrSeveralPrompts) and nothing is typed. A key typed into
// the terminal answers one of them, but not one Caprock can name, so it
// clears none; each goes when its own call's PostToolUse arrives (its
// tool_use_id, taken from the PreToolUse that asked, since PermissionRequest
// carries none), its subagent stops, or the main thread stops.

// Permission is a prompt an owned session is showing or has queued.
type Permission struct {
	// ID names this prompt, so a button drawn for one prompt cannot answer
	// the next.
	ID string `json:"id"`
	// Tool is the tool being asked about ("Bash", "Write", "mcp__…").
	Tool string `json:"tool"`
	// Detail is what it would do: the command, the file, the URL.
	Detail string `json:"detail"`
	// Always labels the "don't ask again" option when the hook suggests one;
	// empty when the button is not offered. Whether the dialog on the screen
	// really has it is checked when the button is pressed.
	Always string    `json:"always,omitempty"`
	Since  time.Time `json:"since"`
	// Queued is how many more prompts are outstanding besides this one.
	Queued int `json:"queued,omitempty"`
	// AgentID and AgentType name the subagent that asked; empty when the
	// main thread did. Claude Code draws a subagent's dialog in the parent's
	// terminal, and a card that did not say whose it was read as the
	// parent's own request.
	AgentID   string `json:"agent_id,omitempty"`
	AgentType string `json:"agent_type,omitempty"`
	// Waiting is every outstanding prompt, oldest first and this one
	// included, when there is more than one; no button answers any of them.
	Waiting []Permission `json:"waiting,omitempty"`

	// input is the tool input, compacted, to recognise the PostToolUse that
	// shows the prompt was answered in the terminal.
	input string
	// toolUseID is the call's id: the hook's when it sends one, else the
	// PreToolUse's that asked (see resolveToolUse).
	toolUseID string
	// ringAt is the session's output offset when the hook arrived: the
	// dialog is drawn after it. Zero for a prompt restored after a restart.
	ringAt uint64
}

// PermissionChoice is one of the answers a button gives.
type PermissionChoice string

// The answers. The key each one presses is read off the screen (menuKey).
const (
	PermissionAllow  PermissionChoice = "allow"
	PermissionAlways PermissionChoice = "always"
	PermissionDeny   PermissionChoice = "deny"
	// PermissionDismiss types nothing: it takes the card away, for a prompt
	// that was settled where no hook saw it (a request that timed out, a
	// check that denied it without a menu).
	PermissionDismiss PermissionChoice = "dismiss"
)

// ErrNoPermission means the session is not showing the prompt named: it was
// answered, it is queued behind another, or it was never asked.
var ErrNoPermission = errors.New("the session is not waiting on that permission prompt")

// ErrNoAlways means the prompt has no "don't ask again" option to pick.
var ErrNoAlways = errors.New("this prompt has no \"don't ask again\" option")

// ErrSeveralPrompts means more than one prompt is outstanding, so which one
// the terminal shows is unknown and no key is pressed.
var ErrSeveralPrompts = errors.New("several approvals are waiting and the terminal shows one of them — answer in the terminal")

// HookSignal is the part of a hook payload that sets or clears a prompt.
type HookSignal struct {
	SessionID string
	Event     string // hook_event_name
	AgentID   string // set inside a subagent
	AgentType string // the subagent's type ("general-purpose"), with AgentID
	Tool      string
	Input     json.RawMessage
	ToolUseID string
	// Suggestions is PermissionRequest's permission_suggestions, verbatim.
	Suggestions json.RawMessage
}

// detailMax caps Detail; a heredoc can be pages long, and the phone shows the
// start of it.
const detailMax = 2000

// ObserveHook updates the prompts an owned session is waiting on from one of
// its hook events. Sessions this manager did not start are ignored: there is
// nothing here that could answer them (rule 7).
func (m *Manager) ObserveHook(sig HookSignal) {
	if _, ok := m.Get(sig.SessionID); !ok {
		return
	}
	switch sig.Event {
	case "PreToolUse":
		m.notePreToolUse(sig)
	case "PermissionRequest":
		if p := newPermission(sig); p != nil {
			if p.toolUseID == "" {
				p.toolUseID = m.resolveToolUse(sig.SessionID, p)
			}
			m.addPermission(sig.SessionID, p)
		}
	case "PostToolUse", "PostToolUseFailure":
		in := compactJSON(sig.Input)
		m.dropPermissions(sig.SessionID, func(p *Permission, done bool) bool {
			if done {
				return false // one call answers one prompt
			}
			if p.toolUseID != "" && sig.ToolUseID != "" {
				return p.toolUseID == sig.ToolUseID
			}
			return p.AgentID == sig.AgentID && p.Tool == sig.Tool && p.input == in
		})
	case "SubagentStop":
		if sig.AgentID != "" {
			m.dropPermissions(sig.SessionID, func(p *Permission, _ bool) bool { return p.AgentID == sig.AgentID })
		}
	case "UserPromptSubmit", "Stop":
		if sig.AgentID == "" {
			m.clearPermission(sig.SessionID)
		}
	case "SessionEnd":
		m.clearPermission(sig.SessionID)
		m.permMu.Lock()
		delete(m.calls, sig.SessionID)
		m.permMu.Unlock()
	}
}

// preCall is one PreToolUse a session made, kept to name the call a later
// PermissionRequest asks about.
type preCall struct {
	agentID, tool, input, toolUseID string
}

// callsKept bounds the PreToolUse calls remembered per session: a
// PermissionRequest follows its PreToolUse within milliseconds, but parallel
// subagents interleave theirs.
const callsKept = 64

func (m *Manager) notePreToolUse(sig HookSignal) {
	if sig.ToolUseID == "" || sig.Tool == "" {
		return
	}
	c := preCall{agentID: sig.AgentID, tool: sig.Tool, input: compactJSON(sig.Input), toolUseID: sig.ToolUseID}
	m.permMu.Lock()
	defer m.permMu.Unlock()
	if m.calls == nil {
		m.calls = map[string][]preCall{}
	}
	m.calls[sig.SessionID] = append(m.calls[sig.SessionID], c)
	if cs := m.calls[sig.SessionID]; len(cs) > callsKept {
		m.calls[sig.SessionID] = append([]preCall(nil), cs[len(cs)-callsKept:]...)
	}
}

// resolveToolUse is the tool_use_id of the newest PreToolUse by the same
// agent with the same tool and input — the call the prompt asks about. The
// PermissionRequest hook carries none (0 of 283 on the owner's database), and
// without it a PostToolUse could only be matched by tool and input, which two
// subagents running the same command share.
func (m *Manager) resolveToolUse(sessionID string, p *Permission) string {
	m.permMu.Lock()
	defer m.permMu.Unlock()
	cs := m.calls[sessionID]
	for i := len(cs) - 1; i >= 0; i-- {
		c := cs[i]
		if c.agentID == p.AgentID && c.tool == p.Tool && c.input == p.input {
			return c.toolUseID
		}
	}
	return ""
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
		ID:        hex.EncodeToString(id[:]),
		Tool:      sig.Tool,
		Detail:    describeToolInput(sig.Input),
		Always:    alwaysLabel(sig.Tool, sig.Suggestions),
		Since:     time.Now().UTC(),
		input:     compactJSON(sig.Input),
		toolUseID: sig.ToolUseID,
		AgentID:   sig.AgentID,
		AgentType: agentTypeOf(sig),
	}
}

// agentTypeOf is the subagent's type, "subagent" when a subagent asked
// without naming one, and "" for the main thread.
func agentTypeOf(sig HookSignal) string {
	if sig.AgentID == "" {
		return ""
	}
	if sig.AgentType != "" {
		return clip(sig.AgentType, 80)
	}
	return "subagent"
}

// PendingPermission returns the oldest prompt an owned session waits on, with
// every other outstanding one in Waiting.
func (m *Manager) PendingPermission(sessionID string) (*Permission, bool) {
	if _, ok := m.Get(sessionID); !ok {
		return nil, false
	}
	m.permMu.Lock()
	defer m.permMu.Unlock()
	return m.headLocked(sessionID)
}

// headLocked is a copy of the oldest prompt of a session, with the count
// queued behind it. The caller holds permMu.
func (m *Manager) headLocked(sessionID string) (*Permission, bool) {
	q := m.perms[sessionID]
	if len(q) == 0 {
		return nil, false
	}
	cp := *q[0]
	cp.Queued = len(q) - 1
	if len(q) > 1 {
		cp.Waiting = make([]Permission, len(q))
		for i, p := range q {
			cp.Waiting[i] = *p
			cp.Waiting[i].Queued, cp.Waiting[i].Waiting = 0, nil
		}
	}
	return &cp, true
}

// AnswerPermission presses the key for choice in an owned session's
// permission dialog, if the prompt named id is the only one outstanding and
// the menu on its screen has that option. With several outstanding it types
// nothing (ErrSeveralPrompts); dismiss, which types nothing, takes any of
// them.
func (m *Manager) AnswerPermission(sessionID, id string, choice PermissionChoice) error {
	a, ok := m.Get(sessionID)
	if !ok {
		return errNotOwned(sessionID)
	}
	switch choice {
	case PermissionAllow, PermissionAlways, PermissionDeny, PermissionDismiss:
	default:
		return fmt.Errorf("unknown choice %q", choice)
	}
	if choice == PermissionDismiss {
		m.permMu.Lock()
		found := false
		for _, p := range m.perms[sessionID] {
			found = found || p.ID == id
		}
		m.permMu.Unlock()
		if !found {
			return ErrNoPermission
		}
		m.dropPermissions(sessionID, func(p *Permission, _ bool) bool { return p.ID == id })
		return nil
	}
	m.permMu.Lock()
	q := m.perms[sessionID]
	if len(q) == 0 || q[0].ID != id {
		m.permMu.Unlock()
		return ErrNoPermission
	}
	if len(q) > 1 {
		m.permMu.Unlock()
		return ErrSeveralPrompts
	}
	if choice == PermissionAlways && q[0].Always == "" {
		m.permMu.Unlock()
		return ErrNoAlways
	}
	at := q[0].ringAt
	m.permMu.Unlock()

	cols, rows := a.size()
	var since []byte
	if at > 0 {
		since, _ = a.ring.r.Since(at)
	}
	key, err := dialogKey(a.ring.snapshot(), since, cols, rows, choice)
	if errors.Is(err, errNoMenu) {
		// No permission menu on the screen at all: the prompt was settled
		// where no hook reported it — it timed out, or a check denied it —
		// and the card is all that is left of it. It goes, as if answered.
		m.log.Info("a permission answer found no menu on the screen; dropping the prompt", "component", "agents", "session_id", sessionID)
		m.permMu.Lock()
		if q := m.perms[sessionID]; len(q) > 0 && q[0].ID == id {
			m.popLocked(sessionID)
		}
		head, _ := m.headLocked(sessionID)
		m.permMu.Unlock()
		m.notifyPermission(sessionID, head)
		m.persistLater(sessionID)
		return ErrNoPermission
	}
	if err != nil {
		m.log.Info("a permission answer found no matching option on the screen", "component", "agents", "session_id", sessionID, "choice", choice)
		return err
	}

	m.permMu.Lock()
	q = m.perms[sessionID]
	if len(q) == 0 || q[0].ID != id {
		// Answered in the terminal while the screen was being read.
		m.permMu.Unlock()
		return ErrNoPermission
	}
	if len(q) > 1 {
		// Another prompt arrived while the screen was being read: the menu
		// read may already be its.
		m.permMu.Unlock()
		return ErrSeveralPrompts
	}
	m.popLocked(sessionID)
	head, _ := m.headLocked(sessionID)
	m.permMu.Unlock()
	m.notifyPermission(sessionID, head)
	_, err = a.sess.Write([]byte(key))
	m.persistLater(sessionID)
	return err
}

// popLocked drops the oldest prompt of a session. The caller holds permMu.
func (m *Manager) popLocked(sessionID string) {
	q := m.perms[sessionID]
	if len(q) <= 1 {
		delete(m.perms, sessionID)
		return
	}
	m.perms[sessionID] = append([]*Permission(nil), q[1:]...)
}

// menuInput is what typed bytes do to a dialog: nothing, answer the one on
// screen (Enter, a digit), or reject and interrupt (a bare Esc, Ctrl+C).
type menuInput int

const (
	menuNone menuInput = iota
	menuAnswer
	menuInterrupt
)

func classifyMenuInput(data []byte) menuInput {
	if len(data) != 1 {
		return menuNone
	}
	switch c := data[0]; {
	case c == 0x1b || c == 0x03:
		return menuInterrupt
	case c == '\r' || c == '\n' || (c >= '0' && c <= '9'):
		return menuAnswer
	}
	return menuNone
}

// typedIntoMenu updates the prompts after a key typed into the terminal.
func (m *Manager) typedIntoMenu(sessionID string, data []byte) {
	switch classifyMenuInput(data) {
	case menuAnswer:
		// With one outstanding, the key answered it. With several it
		// answered whichever the terminal showed, which Caprock cannot name:
		// each then goes with its own call's PostToolUse.
		m.permMu.Lock()
		one := len(m.perms[sessionID]) == 1
		m.permMu.Unlock()
		if one {
			m.dropPermissions(sessionID, func(_ *Permission, done bool) bool { return !done })
		}
	case menuInterrupt:
		m.clearPermission(sessionID)
	}
}

// addPermission queues a new prompt and then shows it if it is the oldest, on
// the hook's own goroutine: the row is committed before the hook is answered
// and before any button can be drawn for it. Written later, a daemon killed in
// the moment after the hook returned — a crash, a Windows stop, which has no
// SIGTERM and so no Shutdown to wait for the write — came back without the
// dialog that was still on the session's screen. The hook's own event is
// written on this goroutine too, so this adds one small write to a request
// that already waits on the database (hookd.RecordTimeout), not a new kind of
// wait.
//
// Clearing stays off the caller's goroutine (persistLater): a keystroke must
// not wait on the database, and a clear lost to a crash is caught on restore
// by the events that say the session moved on.
func (m *Manager) addPermission(sessionID string, p *Permission) {
	if a, ok := m.Get(sessionID); ok && p.ringAt == 0 {
		p.ringAt = a.ring.r.Total()
	}
	m.persistMu.Lock()
	m.permMu.Lock()
	for _, old := range m.perms[sessionID] {
		if p.toolUseID != "" && old.toolUseID == p.toolUseID {
			// The same call's hook again: it is already queued.
			m.permMu.Unlock()
			m.persistMu.Unlock()
			return
		}
	}
	m.permMu.Unlock()
	m.savePermission(sessionID, p)
	m.permMu.Lock()
	if m.perms == nil {
		m.perms = map[string][]*Permission{}
	}
	m.perms[sessionID] = append(m.perms[sessionID], p)
	head, _ := m.headLocked(sessionID)
	m.permMu.Unlock()
	m.persistMu.Unlock()
	// Announced even when queued behind another: the count on the card moves.
	m.notifyPermission(sessionID, head)
}

// dropPermissions removes the prompts drop picks, oldest first; done says
// whether one was removed already. The card is told when its prompt changes.
func (m *Manager) dropPermissions(sessionID string, drop func(p *Permission, done bool) bool) {
	m.permMu.Lock()
	q := m.perms[sessionID]
	if len(q) == 0 {
		m.permMu.Unlock()
		return
	}
	var keep []*Permission
	removed := false
	for _, p := range q {
		if drop(p, removed) {
			removed = true
			continue
		}
		keep = append(keep, p)
	}
	if !removed {
		m.permMu.Unlock()
		return
	}
	if len(keep) == 0 {
		delete(m.perms, sessionID)
	} else {
		m.perms[sessionID] = keep
	}
	head, _ := m.headLocked(sessionID)
	m.permMu.Unlock()
	m.notifyPermission(sessionID, head)
	m.persistLater(sessionID)
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

// persistLater writes a session's prompts — or their absence — to the store
// off the caller's goroutine: a keystroke that answers a menu must not wait on
// a busy database. Used for clears; a new prompt is written in addPermission,
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

// persistPermission makes the stored rows match what memory says now, so a
// daemon restart brings the buttons back (migrations 0039, 0042).
//
// It writes the state current when it runs, not the change that queued it,
// and the writes are serialised: whatever order the goroutines run in, the
// last one to run writes the last state. A stale row is the failure that
// matters — buttons for a dialog no longer on the screen — and
// restorePermission checks the events as well.
func (m *Manager) persistPermission(sessionID string) {
	m.persistMu.Lock()
	defer m.persistMu.Unlock()
	m.permMu.Lock()
	var rows []store.PendingPermission
	for _, p := range m.perms[sessionID] {
		rows = append(rows, storedPermission(sessionID, p))
	}
	m.permMu.Unlock()
	m.writePermissions(func(ctx context.Context, q store.Querier) error {
		return store.ReplacePendingPermissions(ctx, q, sessionID, rows)
	}, sessionID)
}

// savePermission stores one new prompt. The caller holds persistMu.
func (m *Manager) savePermission(sessionID string, p *Permission) {
	row := storedPermission(sessionID, p)
	m.writePermissions(func(ctx context.Context, q store.Querier) error {
		return store.SavePendingPermission(ctx, q, row)
	}, sessionID)
}

func storedPermission(sessionID string, p *Permission) store.PendingPermission {
	return store.PendingPermission{
		SessionID: sessionID, PromptID: p.ID, Tool: p.Tool, Detail: p.Detail,
		Always: p.Always, SinceMs: p.Since.UnixMilli(), Input: p.input,
		ToolUseID: p.toolUseID, AgentID: p.AgentID, AgentType: p.AgentType,
	}
}

// writePermissions runs one write to the stored prompts. The caller holds
// persistMu.
func (m *Manager) writePermissions(write func(context.Context, store.Querier) error, sessionID string) {
	if m.store == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := m.store.WithTx(ctx, func(q store.Querier) error { return write(ctx, q) }); err != nil {
		m.log.Warn("could not store the permission prompt", "component", "agents", "session_id", sessionID, "err", err)
	}
}

// restorePermission brings back the prompts a reattached session was waiting
// on when the last daemon stopped, unless anything since shows they were
// answered. Called from Reattach, before the API serves anything.
//
// Nobody can type into a held session while no daemon runs, but a hook or a
// transcript line can still say a dialog went away — a write lost at the
// moment the daemon stopped, or a transcript read again on this start. Any
// event after a prompt that means the session moved on drops it: a missing
// button costs a tap in the terminal. A stale one types nothing either — the
// screen is read before any key — but it would show the wrong question.
func (m *Manager) restorePermission(ctx context.Context, sessionID string) {
	stored, err := store.ListPendingPermissions(ctx, m.store.DB(), sessionID)
	if err != nil || len(stored) == 0 {
		return
	}
	var q []*Permission
	for _, sp := range stored {
		moved, err := store.MovedOnSince(ctx, m.store.DB(), sessionID, sp.SinceMs)
		if err != nil || moved {
			continue
		}
		q = append(q, &Permission{
			ID: sp.PromptID, Tool: sp.Tool, Detail: sp.Detail, Always: sp.Always,
			Since: time.UnixMilli(sp.SinceMs).UTC(), input: sp.Input,
			toolUseID: sp.ToolUseID, AgentID: sp.AgentID, AgentType: sp.AgentType,
		})
	}
	m.permMu.Lock()
	if m.perms == nil {
		m.perms = map[string][]*Permission{}
	}
	if len(q) > 0 {
		m.perms[sessionID] = q
	}
	m.permMu.Unlock()
	if len(q) != len(stored) {
		m.persistPermission(sessionID)
	}
	if len(q) > 0 {
		m.log.Info("restored the permission prompts a session was waiting on", "component", "agents", "session_id", sessionID, "count", len(q), "tool", q[0].Tool)
	}
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

// alwaysLabel names the "don't ask again" option from the hook's first
// suggestion, or returns "" when there is none — or when it is a kind this
// code has not seen on a real prompt. ExitPlanMode's options are plan
// approvals, not "don't ask again". The label is what the card says; the key
// is still picked from the screen's own wording.
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
