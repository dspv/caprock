package agents

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

// The footers Claude Code 2.1.296 draws under its prompt, one per mode
// (read from the bundled source: symbol, indicator, " on").
var footers = map[string]string{
	ModeDefault: "⏸ manual mode on",
	ModePlan:    "⏸ plan mode on",
	ModeAccept:  "⏵⏵ accept edits on (shift+tab to cycle)",
	ModeBypass:  "⏵⏵ bypass permissions on (shift+tab to cycle)",
	ModeAuto:    "⏵⏵ auto mode on (shift+tab to cycle)",
	ModeDontAsk: "⏵⏵ don't ask on (shift+tab to cycle)",
}

func TestScreenModeReadsTheFooter(t *testing.T) {
	for mode, footer := range footers {
		screen := []string{"● Done.", "", strings.Repeat("─", 40), "> ", strings.Repeat("─", 40), "  " + footer + " · ? for shortcuts", ""}
		if got, ok := ScreenMode(screen); !ok || got != mode {
			t.Errorf("%q: got %q, %v; want %q", footer, got, ok, mode)
		}
	}
	// Words in the conversation are not the footer: only the bottom rows
	// count, and only with the symbol in front.
	for _, screen := range [][]string{
		{"⏵⏵ bypass permissions on", "one", "two", "three", "four", "> "},
		{"I turned plan mode on for you.", "> "},
		{"", ""},
	} {
		if got, ok := ScreenMode(screen); ok {
			t.Errorf("%q: read %q from no footer", screen, got)
		}
	}
}

// Claude Code 2.1.296's cycle (BBt in the bundled source): bypass only when
// the process may enter it, auto only when the account has it.
func TestNextModeFollowsClaudeCodesCycle(t *testing.T) {
	walk := func(bypass, auto bool) []string {
		out := []string{ModeDefault}
		for m := NextMode(ModeDefault, bypass, auto); m != ModeDefault; m = NextMode(m, bypass, auto) {
			out = append(out, m)
		}
		return out
	}
	for _, tc := range []struct {
		bypass, auto bool
		want         []string
	}{
		{false, false, []string{ModeDefault, ModeAccept, ModePlan}},
		{true, false, []string{ModeDefault, ModeAccept, ModePlan, ModeBypass}},
		{false, true, []string{ModeDefault, ModeAccept, ModePlan, ModeAuto}},
		{true, true, []string{ModeDefault, ModeAccept, ModePlan, ModeBypass, ModeAuto}},
	} {
		if got := walk(tc.bypass, tc.auto); !slices.Equal(got, tc.want) {
			t.Errorf("bypass=%v auto=%v: %v, want %v", tc.bypass, tc.auto, got, tc.want)
		}
	}
	if NextMode(ModeDontAsk, true, true) != ModeDefault || NextMode("manual", false, false) != ModeAccept {
		t.Error("dontAsk leaves to default; manual is default")
	}
}

func TestCrossesBypass(t *testing.T) {
	for _, tc := range []struct {
		from, to string
		bypass   bool
		want     bool
	}{
		{ModePlan, ModeDefault, true, true},   // plan → bypass → default
		{ModePlan, ModeAuto, true, true},      // plan → bypass → auto
		{ModeAccept, ModeDefault, true, true}, // accept → plan → bypass → default
		{ModePlan, ModeDefault, false, false}, // no bypass in the cycle
		{ModeDefault, ModePlan, true, false},  // forwards, short of bypass
		{ModePlan, ModeBypass, true, false},   // bypass is where it is going
		{ModeBypass, ModeDefault, true, false},
	} {
		if got := CrossesBypass(tc.from, tc.to, tc.bypass); got != tc.want {
			t.Errorf("%s → %s (bypass %v): %v, want %v", tc.from, tc.to, tc.bypass, got, tc.want)
		}
	}
}

func TestReadLaunch(t *testing.T) {
	for _, tc := range []struct {
		cmd  string
		want LaunchFacts
	}{
		{"claude --session-id x", LaunchFacts{Mode: ModeDefault}},
		{"claude --session-id x --permission-mode plan --model claude-opus-5-5", LaunchFacts{Mode: ModePlan, Model: "claude-opus-5-5"}},
		{"claude --resume x --permission-mode manual --allow-dangerously-skip-permissions", LaunchFacts{Mode: ModeDefault, Bypass: true}},
		{"claude --session-id x --dangerously-skip-permissions", LaunchFacts{Mode: ModeBypass, Bypass: true}},
		{"claude --session-id x --permission-mode bypassPermissions", LaunchFacts{Mode: ModeBypass, Bypass: true}},
		// The project's instructions are text, whatever they say.
		{"claude --session-id x --permission-mode acceptEdits --append-system-prompt never use --dangerously-skip-permissions", LaunchFacts{Mode: ModeAccept}},
	} {
		if got := ReadLaunch(tc.cmd); got != tc.want {
			t.Errorf("%q: %+v, want %+v", tc.cmd, got, tc.want)
		}
	}
}

// fakeModes makes the fake session behave as Claude Code's footer does: each
// Shift+Tab moves the mode on and redraws the footer.
func fakeModes(t *testing.T, m *Manager, f *fakePTY, start string, bypass bool) {
	t.Helper()
	a, _ := m.Get("fixed-session-id")
	mode := start
	a.ring.write([]byte("\r\n> \r\n" + footers[mode] + "\r\n"))
	f.session.mu.Lock()
	f.session.onWrite = func(p []byte) {
		if string(p) == modeKey {
			mode = NextMode(mode, bypass, false)
			a.ring.write([]byte("\x1b[1A\r\x1b[2K" + footers[mode] + "\r\n"))
		}
	}
	f.session.mu.Unlock()
}

func TestSwitchModePressesShiftTabUntilTheFooterSaysSo(t *testing.T) {
	m, f, _ := spawnOwned(t)
	fakeModes(t, m, f, ModeDefault, false)
	got, err := m.SwitchMode(context.Background(), "fixed-session-id", ModePlan)
	if err != nil || got != ModePlan {
		t.Fatalf("got %q, %v", got, err)
	}
	if typed := f.session.typed(); typed != modeKey+modeKey {
		t.Fatalf("typed %q, want two Shift+Tabs", typed)
	}
	if mode, src, _, _ := m.SessionMode("fixed-session-id"); mode != ModePlan || src != SourceScreen {
		t.Fatalf("SessionMode %q from %q", mode, src)
	}
	// Already there: nothing is typed.
	if got, err := m.SwitchMode(context.Background(), "fixed-session-id", ModePlan); err != nil || got != ModePlan {
		t.Fatalf("again: %q, %v", got, err)
	}
	if typed := f.session.typed(); typed != modeKey+modeKey {
		t.Fatalf("typed %q after a switch to the mode it was in", typed)
	}
}

func TestSwitchModeReachesBypassOnlyWhenTheProcessMay(t *testing.T) {
	m, f, _ := spawnOwned(t)
	fakeModes(t, m, f, ModeAccept, true)
	if got, err := m.SwitchMode(context.Background(), "fixed-session-id", ModeBypass); err != nil || got != ModeBypass {
		t.Fatalf("got %q, %v", got, err)
	}

	m2, f2, _ := spawnOwned(t)
	fakeModes(t, m2, f2, ModeAccept, false)
	got, err := m2.SwitchMode(context.Background(), "fixed-session-id", ModeBypass)
	if !errors.Is(err, ErrModeUnreachable) {
		t.Fatalf("got %q, %v; want unreachable", got, err)
	}
	// accept → plan → default → accept: round once, then stop.
	if n := strings.Count(f2.session.typed(), modeKey); n != 3 {
		t.Fatalf("pressed %d times", n)
	}
	if got != ModeAccept {
		t.Fatalf("left in %q", got)
	}
}

func TestSwitchModeStopsWhenShiftTabChangesNothing(t *testing.T) {
	defer func(d time.Duration) { modeWait = d }(modeWait)
	modeWait = 300 * time.Millisecond
	m, f, _ := spawnOwned(t)
	show(t, m, "\r\n> \r\n"+footers[ModeAccept]+"\r\n")
	_, err := m.SwitchMode(context.Background(), "fixed-session-id", ModePlan)
	if !errors.Is(err, ErrModeStuck) {
		t.Fatalf("err %v", err)
	}
	if typed := f.session.typed(); typed != modeKey {
		t.Fatalf("typed %q, want one Shift+Tab and no more", typed)
	}
}

func TestSwitchModeTypesNothingUnderAPrompt(t *testing.T) {
	m, f, _ := spawnOwned(t)
	show(t, m, bashRuleMenu)
	if _, err := m.SwitchMode(context.Background(), "fixed-session-id", ModePlan); !errors.Is(err, ErrModeMenu) {
		t.Fatalf("err %v", err)
	}
	m.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
	if _, err := m.SwitchMode(context.Background(), "fixed-session-id", ModePlan); !errors.Is(err, ErrModeMenu) {
		t.Fatalf("with a hook's prompt: %v", err)
	}
	if typed := f.session.typed(); typed != "" {
		t.Fatalf("typed %q", typed)
	}
}

func TestSessionModeFallsBackToTheHookThenTheCommandLine(t *testing.T) {
	m, _, _ := spawnOwned(t)
	if mode, src, _, ok := m.SessionMode("fixed-session-id"); !ok || mode != ModeDefault || src != SourceLaunch {
		t.Fatalf("before any hook: %q %q %v", mode, src, ok)
	}
	m.ObserveHook(HookSignal{SessionID: "fixed-session-id", Event: "UserPromptSubmit", PermissionMode: "acceptEdits"})
	if mode, src, _, _ := m.SessionMode("fixed-session-id"); mode != ModeAccept || src != SourceHook {
		t.Fatalf("after a hook: %q %q", mode, src)
	}
	// A subagent's hook is not the session's mode.
	m.ObserveHook(HookSignal{SessionID: "fixed-session-id", Event: "PreToolUse", AgentID: "a1", PermissionMode: "plan"})
	if mode, _, _, _ := m.SessionMode("fixed-session-id"); mode != ModeAccept {
		t.Fatalf("a subagent's hook moved it to %q", mode)
	}
	if _, _, _, ok := m.SessionMode("someone-elses"); ok {
		t.Fatal("a session Caprock did not start has no mode here")
	}
}

// --allow-dangerously-skip-permissions goes on a Claude Code start only when
// the bypass warning was accepted, and never beside the bypass flag itself.
func TestAllowBypassFlagNeedsConsent(t *testing.T) {
	const allow = "--allow-dangerously-skip-permissions"
	for _, tc := range []struct {
		mode    string
		consent bool
		want    bool
	}{
		{"acceptEdits", true, true},
		{"", true, true},
		{"plan", false, false},
		{"bypassPermissions", true, false},
	} {
		m, _, f := newMgr(t)
		m.BypassConsent = func(string) bool { return tc.consent }
		if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), PermissionMode: tc.mode}); err != nil {
			t.Fatal(err)
		}
		if got := slices.Contains(f.lastSpec.Args, allow); got != tc.want {
			t.Errorf("mode %q consent %v: allow flag %v, want %v (%v)", tc.mode, tc.consent, got, tc.want, f.lastSpec.Args)
		}
		m.Shutdown()
	}
}

func TestStopForRestartWaitsForTheProcess(t *testing.T) {
	m, f, _ := spawnOwned(t)
	if _, _, err := m.StopForRestart(context.Background(), "fixed-session-id"); err != nil {
		t.Fatal(err)
	}
	if !f.session.termed.Load() {
		t.Fatal("not asked to stop first")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, held := m.Get("fixed-session-id"); !held {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("still registered after it stopped")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, _, err := m.StopForRestart(context.Background(), "nobody"); !errors.Is(err, ErrNotOwned) {
		t.Fatalf("a session not ours: %v", err)
	}
}
