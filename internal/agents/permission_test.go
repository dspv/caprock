package agents

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// Payloads as Claude Code 2.1.289 sent them for three real prompts, trimmed to
// the fields read. The labels the screen showed for option 2 are noted.
const (
	// "2. Yes, and don't ask again for: python3 *"
	bashRule = `{"tool_name":"Bash","tool_input":{"command":"python3 -c \"print(1)\"","description":"Run Python print statement"},"permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"python3 -c \"print(1)\""}],"behavior":"allow","destination":"localSettings"}]}`
	// "2. Yes, and switch to accept edits … for this session (shift+tab)"
	writeMode = `{"tool_name":"Write","tool_input":{"file_path":"/work/proj/a.txt","content":"hi"},"permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}`
	// "2. Yes, and always allow access to /work/proj from this project"
	bashDir = `{"tool_name":"Bash","tool_input":{"command":"date > out.txt","description":"Write current date to out.txt"},"permission_suggestions":[{"type":"addDirectories","directories":["/work/proj"],"destination":"session"}]}`
)

func signalFrom(t *testing.T, id, raw string) HookSignal {
	t.Helper()
	var p struct {
		Tool        string          `json:"tool_name"`
		Input       json.RawMessage `json:"tool_input"`
		Suggestions json.RawMessage `json:"permission_suggestions"`
	}
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatal(err)
	}
	return HookSignal{SessionID: id, Event: "PermissionRequest", Tool: p.Tool, Input: p.Input, Suggestions: p.Suggestions}
}

// spawnOwned starts one owned session on the fake PTY and records every
// permission change the manager announces.
func spawnOwned(t *testing.T) (*Manager, *fakePTY, *[]*Permission) {
	t.Helper()
	m, _, f := newMgr(t)
	t.Cleanup(m.Shutdown)
	var mu sync.Mutex
	seen := &[]*Permission{}
	m.OnPermission = func(_ string, p *Permission) {
		mu.Lock()
		defer mu.Unlock()
		*seen = append(*seen, p)
	}
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	return m, f, seen
}

// The dialog for bashRule as it is drawn, and auto mode's two-option one.
var (
	bashRuleMenu = diffed(0, " Bash command", `   python3 -c "print(1)"`, "", " Do you want to proceed?", " ❯ 1. Yes",
		"   2. Yes, and don't ask again for: python3 *", "   3. No, and tell Claude what to do differently (esc)")
	autoModeMenu = diffed(0, " This command requires approval", `   python3 -c "print(1)"`, "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No")
)

// show puts output on a session's screen, as if Claude Code had drawn it.
func show(t *testing.T, m *Manager, out string) {
	t.Helper()
	a, ok := m.Get("fixed-session-id")
	if !ok {
		t.Fatal("no session")
	}
	a.ring.write([]byte(out))
}

func (s *fakeSession) typed() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return string(s.written)
}

func TestAPermissionPromptIsDescribedFromItsHook(t *testing.T) {
	for _, tc := range []struct {
		name, raw, tool, detail, always string
	}{
		{"bash rule", bashRule, "Bash", `python3 -c "print(1)"`, "Yes, and don’t ask again"},
		{"write mode", writeMode, "Write", "/work/proj/a.txt", "Yes, allow all edits this session"},
		{"bash folder", bashDir, "Bash", "date > out.txt", "Yes, and allow this folder"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, _, seen := spawnOwned(t)
			m.ObserveHook(signalFrom(t, "fixed-session-id", tc.raw))
			p, ok := m.PendingPermission("fixed-session-id")
			if !ok || p.Tool != tc.tool || p.Detail != tc.detail || p.Always != tc.always || p.ID == "" {
				t.Fatalf("got %+v, %v", p, ok)
			}
			if len(*seen) != 1 || (*seen)[0] == nil {
				t.Fatalf("announced %v", *seen)
			}
		})
	}
}

func TestEachButtonPressesItsKey(t *testing.T) {
	for _, tc := range []struct {
		choice PermissionChoice
		key    string
	}{{PermissionAllow, "1"}, {PermissionAlways, "2"}, {PermissionDeny, "\x1b"}} {
		t.Run(string(tc.choice), func(t *testing.T) {
			m, f, seen := spawnOwned(t)
			m.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
			show(t, m, bashRuleMenu)
			p, _ := m.PendingPermission("fixed-session-id")
			if err := m.AnswerPermission("fixed-session-id", p.ID, tc.choice); err != nil {
				t.Fatal(err)
			}
			if got := f.session.typed(); got != tc.key {
				t.Fatalf("typed %q, want %q", got, tc.key)
			}
			if _, ok := m.PendingPermission("fixed-session-id"); ok {
				t.Fatal("still pending after the answer")
			}
			if last := (*seen)[len(*seen)-1]; last != nil {
				t.Fatalf("last announcement %+v, want cleared", last)
			}
			// The same button again answers nothing: the prompt is gone.
			if err := m.AnswerPermission("fixed-session-id", p.ID, tc.choice); !errors.Is(err, ErrNoPermission) {
				t.Fatalf("second press: %v", err)
			}
			if got := f.session.typed(); got != tc.key {
				t.Fatalf("second press typed %q", got)
			}
		})
	}
}

func TestAStaleButtonTypesNothing(t *testing.T) {
	m, f, _ := spawnOwned(t)
	m.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
	show(t, m, bashRuleMenu)
	old, _ := m.PendingPermission("fixed-session-id")
	_ = m.Input("fixed-session-id", []byte("1")) // answered in the terminal
	if err := m.AnswerPermission("fixed-session-id", old.ID, PermissionAllow); !errors.Is(err, ErrNoPermission) {
		t.Fatalf("answered a prompt answered already: %v", err)
	}
	if f.session.typed() != "1" {
		t.Fatalf("typed %q", f.session.typed())
	}
}

// The bug the owner lost work to: the hook suggests "don't ask again", but
// auto mode's dialog is "1. Yes 2. No". The old code typed "2" — No.
func TestAlwaysIsNotTypedIntoATwoOptionMenu(t *testing.T) {
	m, f, seen := spawnOwned(t)
	m.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
	show(t, m, autoModeMenu)
	p, _ := m.PendingPermission("fixed-session-id")
	if p.Always == "" {
		t.Fatal("the hook's suggestion should still label the button")
	}
	if err := m.AnswerPermission("fixed-session-id", p.ID, PermissionAlways); !errors.Is(err, ErrNotOnPrompt) {
		t.Fatalf("got %v, want ErrNotOnPrompt", err)
	}
	if f.session.typed() != "" {
		t.Fatalf("typed %q into a menu without the option", f.session.typed())
	}
	// Refused, not answered: the prompt and its card stay.
	if q, ok := m.PendingPermission("fixed-session-id"); !ok || q.ID != p.ID || (*seen)[len(*seen)-1] == nil {
		t.Fatal("a refused answer cleared the prompt")
	}
	// Yes is still on the menu, and is option 1.
	if err := m.AnswerPermission("fixed-session-id", p.ID, PermissionAllow); err != nil {
		t.Fatal(err)
	}
	if f.session.typed() != "1" {
		t.Fatalf("typed %q", f.session.typed())
	}
}

// With no dialog on the screen nothing is typed — not even Esc, which would
// interrupt the turn instead of answering anything.
func TestNothingIsTypedWithoutAMenuOnScreen(t *testing.T) {
	// With no permission menu on the screen the prompt was settled where no
	// hook saw it (it timed out, a check denied it): nothing is typed and the
	// card goes, as if answered.
	for _, choice := range []PermissionChoice{PermissionAllow, PermissionAlways, PermissionDeny} {
		t.Run(string(choice), func(t *testing.T) {
			m, f, _ := spawnOwned(t)
			m.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
			show(t, m, "✻ Thinking… (3s · esc to interrupt)\r\n")
			p, _ := m.PendingPermission("fixed-session-id")
			if err := m.AnswerPermission("fixed-session-id", p.ID, choice); !errors.Is(err, ErrNoPermission) {
				t.Fatalf("got %v", err)
			}
			if f.session.typed() != "" {
				t.Fatalf("typed %q", f.session.typed())
			}
			if _, ok := m.PendingPermission("fixed-session-id"); ok {
				t.Fatal("the stale prompt is still pending")
			}
		})
	}
}

// Dismiss takes the card away and types nothing, menu or not; it answers only
// the prompt it was drawn for.
func TestDismissTypesNothing(t *testing.T) {
	m, f, seen := spawnOwned(t)
	m.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
	show(t, m, bashRuleMenu)
	p, _ := m.PendingPermission("fixed-session-id")
	if err := m.AnswerPermission("fixed-session-id", "not-"+p.ID, PermissionDismiss); !errors.Is(err, ErrNoPermission) {
		t.Fatalf("a stale id: %v", err)
	}
	if err := m.AnswerPermission("fixed-session-id", p.ID, PermissionDismiss); err != nil {
		t.Fatal(err)
	}
	if f.session.typed() != "" {
		t.Fatalf("typed %q", f.session.typed())
	}
	if _, ok := m.PendingPermission("fixed-session-id"); ok {
		t.Fatal("still pending after dismiss")
	}
	if last := (*seen)[len(*seen)-1]; last != nil {
		t.Fatalf("the live frame still carries %+v", last)
	}
}

// Claude Code queues dialogs and shows the oldest; so does the card. A later
// hook does not overwrite an earlier unanswered prompt.
func TestPromptsQueueOldestFirst(t *testing.T) {
	m, f, seen := spawnOwned(t)
	first := signalFrom(t, "fixed-session-id", bashRule)
	first.ToolUseID = "toolu_1"
	second := signalFrom(t, "fixed-session-id", writeMode)
	second.ToolUseID = "toolu_2"
	second.AgentID = "sub-1"
	m.ObserveHook(first)
	m.ObserveHook(second)
	m.ObserveHook(second) // the same call's hook again is not a third prompt
	head, ok := m.PendingPermission("fixed-session-id")
	if !ok || head.Tool != "Bash" || head.Queued != 1 {
		t.Fatalf("head %+v, %v", head, ok)
	}
	// The queued one cannot be answered: its dialog is not on the screen.
	show(t, m, bashRuleMenu)
	if last := (*seen)[len(*seen)-1]; last == nil || last.ID != head.ID {
		t.Fatalf("announced %+v", last)
	}
	m.permMu.Lock()
	queuedID := m.perms["fixed-session-id"][1].ID
	m.permMu.Unlock()
	if err := m.AnswerPermission("fixed-session-id", queuedID, PermissionAllow); !errors.Is(err, ErrNoPermission) {
		t.Fatalf("answered a queued prompt: %v", err)
	}
	if err := m.AnswerPermission("fixed-session-id", head.ID, PermissionAllow); err != nil {
		t.Fatal(err)
	}
	if f.session.typed() != "1" {
		t.Fatalf("typed %q", f.session.typed())
	}
	next, ok := m.PendingPermission("fixed-session-id")
	if !ok || next.ID != queuedID || next.Tool != "Write" || next.Queued != 0 {
		t.Fatalf("next %+v, %v", next, ok)
	}
	if last := (*seen)[len(*seen)-1]; last == nil || last.ID != queuedID {
		t.Fatalf("the card was not moved to the next prompt: %+v", last)
	}
}

func TestQueuedPromptsAreClearedByWhatAnswersThem(t *testing.T) {
	mk := func(t *testing.T) *Manager {
		m, _, _ := spawnOwned(t)
		a := signalFrom(t, "fixed-session-id", bashRule)
		a.ToolUseID = "toolu_1"
		b := signalFrom(t, "fixed-session-id", writeMode)
		b.AgentID = "sub-1"
		m.ObserveHook(a)
		m.ObserveHook(b)
		return m
	}
	tools := func(m *Manager) string {
		m.permMu.Lock()
		defer m.permMu.Unlock()
		var s []string
		for _, p := range m.perms["fixed-session-id"] {
			s = append(s, p.Tool)
		}
		return strings.Join(s, ",")
	}
	for _, tc := range []struct {
		name  string
		event func(m *Manager)
		left  string
	}{
		{"Enter answers the one on screen", func(m *Manager) { _ = m.Input("fixed-session-id", []byte("\r")) }, "Write"},
		{"Esc rejects and interrupts them all", func(m *Manager) { _ = m.Input("fixed-session-id", []byte("\x1b")) }, ""},
		{"the queued call's PostToolUse", func(m *Manager) {
			s := signalFrom(t, "fixed-session-id", writeMode)
			s.Event, s.AgentID = "PostToolUse", "sub-1"
			m.ObserveHook(s)
		}, "Bash"},
		{"a PostToolUse by tool_use_id", func(m *Manager) {
			m.ObserveHook(HookSignal{SessionID: "fixed-session-id", Event: "PostToolUse", Tool: "Bash", ToolUseID: "toolu_1", Input: json.RawMessage(`{}`)})
		}, "Write"},
		{"the subagent's stop", func(m *Manager) {
			m.ObserveHook(HookSignal{SessionID: "fixed-session-id", Event: "SubagentStop", AgentID: "sub-1"})
		}, "Bash"},
		{"another subagent's stop", func(m *Manager) {
			m.ObserveHook(HookSignal{SessionID: "fixed-session-id", Event: "SubagentStop", AgentID: "sub-2"})
		}, "Bash,Write"},
		{"Stop", func(m *Manager) { m.ObserveHook(HookSignal{SessionID: "fixed-session-id", Event: "Stop"}) }, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := mk(t)
			tc.event(m)
			if got := tools(m); got != tc.left {
				t.Fatalf("left %q, want %q", got, tc.left)
			}
		})
	}
}

func TestAlwaysIsRefusedWhenNotOffered(t *testing.T) {
	m, f, _ := spawnOwned(t)
	sig := signalFrom(t, "fixed-session-id", bashRule)
	sig.Suggestions = nil
	m.ObserveHook(sig)
	p, _ := m.PendingPermission("fixed-session-id")
	if p.Always != "" {
		t.Fatalf("always offered: %q", p.Always)
	}
	if err := m.AnswerPermission("fixed-session-id", p.ID, PermissionAlways); !errors.Is(err, ErrNoAlways) {
		t.Fatalf("got %v", err)
	}
	if f.session.typed() != "" {
		t.Fatalf("typed %q", f.session.typed())
	}
}

func TestAnsweringElsewhereClearsThePrompt(t *testing.T) {
	for _, tc := range []struct {
		name  string
		clear func(m *Manager)
		gone  bool
	}{
		{"enter in the terminal", func(m *Manager) { _ = m.Input("fixed-session-id", []byte("\r")) }, true},
		{"esc in the terminal", func(m *Manager) { _ = m.Input("fixed-session-id", []byte("\x1b")) }, true},
		{"a digit in the terminal", func(m *Manager) { _ = m.Input("fixed-session-id", []byte("3")) }, true},
		{"an arrow moves, does not answer", func(m *Manager) { _ = m.Input("fixed-session-id", []byte("\x1b[B")) }, false},
		{"its own PostToolUse", func(m *Manager) {
			s := signalFrom(t, "fixed-session-id", bashRule)
			s.Event = "PostToolUse"
			m.ObserveHook(s)
		}, true},
		{"another tool's PostToolUse", func(m *Manager) {
			s := signalFrom(t, "fixed-session-id", writeMode)
			s.Event = "PostToolUse"
			m.ObserveHook(s)
		}, false},
		{"Stop", func(m *Manager) { m.ObserveHook(HookSignal{SessionID: "fixed-session-id", Event: "Stop"}) }, true},
		{"a subagent's Stop", func(m *Manager) {
			m.ObserveHook(HookSignal{SessionID: "fixed-session-id", Event: "SubagentStop", AgentID: "a1"})
		}, false},
		{"the next prompt", func(m *Manager) { m.ObserveHook(HookSignal{SessionID: "fixed-session-id", Event: "UserPromptSubmit"}) }, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, _, _ := spawnOwned(t)
			m.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
			tc.clear(m)
			if _, ok := m.PendingPermission("fixed-session-id"); ok == tc.gone {
				t.Fatalf("pending = %v, want gone = %v", ok, tc.gone)
			}
		})
	}
}

// Rule 7: a session Caprock did not start has no buttons, because nothing
// here could press them.
func TestOnlyOwnedSessionsGetAPrompt(t *testing.T) {
	m, _, seen := spawnOwned(t)
	m.ObserveHook(signalFrom(t, "someone-elses", bashRule))
	if _, ok := m.PendingPermission("someone-elses"); ok || len(*seen) != 0 {
		t.Fatal("a session Caprock did not start got a prompt")
	}
	if err := m.AnswerPermission("someone-elses", "x", PermissionAllow); !errors.Is(err, ErrNotOwned) {
		t.Fatalf("got %v", err)
	}
}

// AskUserQuestion's menu is the question's answers; "1" would pick one.
func TestAQuestionIsNotAPermission(t *testing.T) {
	m, _, _ := spawnOwned(t)
	m.ObserveHook(HookSignal{SessionID: "fixed-session-id", Event: "PermissionRequest", Tool: "AskUserQuestion", Input: json.RawMessage(`{"questions":[]}`)})
	if _, ok := m.PendingPermission("fixed-session-id"); ok {
		t.Fatal("a question was shown as a permission prompt")
	}
}

func TestDetailIsClipped(t *testing.T) {
	long := make([]byte, 5000)
	for i := range long {
		long[i] = 'x'
	}
	in, _ := json.Marshal(map[string]string{"command": string(long)})
	if d := describeToolInput(in); len([]rune(d)) != detailMax+1 {
		t.Fatalf("detail is %d runes", len([]rune(d)))
	}
	if d := describeToolInput(json.RawMessage(`{ "a" : 1 }`)); d != `{"a":1}` {
		t.Fatalf("detail %q", d)
	}
}

// restartedMgr is a second manager on the same store, holding the same
// session, the way a daemon that reattached it would.
func restartedMgr(t *testing.T, st *store.Store) (*Manager, *fakePTY) {
	t.Helper()
	f := &fakePTY{}
	m := &Manager{pty: f, store: st, log: discardLogger(), dataDir: t.TempDir(), claude: "claude", agents: map[string]*Agent{}, NewSessionID: func() string { return "fixed-session-id" }}
	t.Cleanup(m.Shutdown)
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	return m, f
}

// The dialog stays on the session's screen across a daemon restart (ADR-033),
// so its buttons come back with it — under the same id, so a button drawn
// before the restart still answers it and nothing else does.
func TestAPromptSurvivesADaemonRestart(t *testing.T) {
	m1, st, _ := newMgr(t)
	t.Cleanup(m1.Shutdown)
	if _, err := m1.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	m1.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
	before, _ := m1.PendingPermission("fixed-session-id")
	m1.persisting.Wait()

	m2, f2 := restartedMgr(t, st)
	m2.restorePermission(context.Background(), "fixed-session-id")
	after, ok := m2.PendingPermission("fixed-session-id")
	if !ok || after.ID != before.ID || after.Tool != before.Tool || after.Detail != before.Detail || after.Always != before.Always {
		t.Fatalf("after a restart: %+v, %v; before: %+v", after, ok, before)
	}
	if err := m2.AnswerPermission("fixed-session-id", "not-that-one", PermissionAllow); !errors.Is(err, ErrNoPermission) {
		t.Fatalf("a stale id answered: %v", err)
	}
	show(t, m2, bashRuleMenu) // the pty-host's snapshot, replayed into the new daemon
	if err := m2.AnswerPermission("fixed-session-id", before.ID, PermissionAllow); err != nil {
		t.Fatal(err)
	}
	if got := f2.session.typed(); got != "1" {
		t.Fatalf("typed %q", got)
	}
	// Its own PostToolUse is still recognised after the restart.
	m2.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
	post := signalFrom(t, "fixed-session-id", bashRule)
	post.Event = "PostToolUse"
	m2.ObserveHook(post)
	if _, ok := m2.PendingPermission("fixed-session-id"); ok {
		t.Fatal("the PostToolUse did not clear a prompt")
	}
}

// A prompt answered before the restart stays answered after it.
func TestAnAnsweredPromptDoesNotComeBack(t *testing.T) {
	for _, tc := range []struct {
		name   string
		answer func(t *testing.T, m *Manager, st *store.Store)
	}{
		{"enter in the terminal", func(_ *testing.T, m *Manager, _ *store.Store) { _ = m.Input("fixed-session-id", []byte("\r")) }},
		{"a button", func(t *testing.T, m *Manager, _ *store.Store) {
			show(t, m, bashRuleMenu)
			p, _ := m.PendingPermission("fixed-session-id")
			if err := m.AnswerPermission("fixed-session-id", p.ID, PermissionDeny); err != nil {
				t.Fatal(err)
			}
		}},
		{"Stop", func(_ *testing.T, m *Manager, _ *store.Store) {
			m.ObserveHook(HookSignal{SessionID: "fixed-session-id", Event: "Stop"})
		}},
		// The write that would have cleared it was lost, but the session's
		// events say it moved on: the restore believes the events.
		{"a later event", func(t *testing.T, _ *Manager, st *store.Store) {
			ctx := context.Background()
			err := st.WithTx(ctx, func(q store.Querier) error {
				_, err := store.InsertEvent(ctx, q, &event.Event{
					Ts: time.Now().Add(time.Second), SessionID: "fixed-session-id", Source: event.SourceHook,
					Kind: event.KindToolPost, Tool: "Bash", Payload: json.RawMessage(`{}`),
				})
				return err
			})
			if err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m1, st, _ := newMgr(t)
			t.Cleanup(m1.Shutdown)
			if _, err := m1.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()}); err != nil {
				t.Fatal(err)
			}
			m1.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
			m1.persisting.Wait()
			tc.answer(t, m1, st)
			m1.persisting.Wait()

			m2, f2 := restartedMgr(t, st)
			m2.restorePermission(context.Background(), "fixed-session-id")
			if p, ok := m2.PendingPermission("fixed-session-id"); ok {
				t.Fatalf("an answered prompt came back: %+v", p)
			}
			if err := m2.AnswerPermission("fixed-session-id", "anything", PermissionAllow); !errors.Is(err, ErrNoPermission) {
				t.Fatalf("got %v", err)
			}
			if f2.session.typed() != "" {
				t.Fatalf("typed %q", f2.session.typed())
			}
			if ps, _ := store.ListPendingPermissions(context.Background(), st.DB(), "fixed-session-id"); len(ps) != 0 {
				t.Fatal("the stored prompt is still there")
			}
		})
	}
}

// A crash, not a stop: the daemon is killed the moment the hook that drew the
// dialog has been answered, with no Shutdown to flush anything. The prompt is
// already in the store, because it was written before the hook returned —
// nothing here waits on the manager's background writes.
func TestAPromptIsStoredBeforeTheHookReturns(t *testing.T) {
	m1, st, _ := newMgr(t)
	t.Cleanup(m1.Shutdown)
	if _, err := m1.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	m1.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
	before, _ := m1.PendingPermission("fixed-session-id")

	sp, err := store.ListPendingPermissions(context.Background(), st.DB(), "fixed-session-id")
	if err != nil || len(sp) != 1 || sp[0].PromptID != before.ID {
		t.Fatalf("stored when the hook returned: %+v, %v; want prompt %s", sp, err, before.ID)
	}
	m2, _ := restartedMgr(t, st)
	m2.restorePermission(context.Background(), "fixed-session-id")
	if after, ok := m2.PendingPermission("fixed-session-id"); !ok || after.ID != before.ID {
		t.Fatalf("after a crash: %+v, %v; want prompt %s", after, ok, before.ID)
	}
}
