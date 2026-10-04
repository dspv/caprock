package agents

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
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
	old, _ := m.PendingPermission("fixed-session-id")
	m.ObserveHook(signalFrom(t, "fixed-session-id", writeMode))
	if err := m.AnswerPermission("fixed-session-id", old.ID, PermissionAllow); !errors.Is(err, ErrNoPermission) {
		t.Fatalf("answered a replaced prompt: %v", err)
	}
	if f.session.typed() != "" {
		t.Fatalf("typed %q", f.session.typed())
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
