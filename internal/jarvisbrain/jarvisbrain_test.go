package jarvisbrain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// TestMain lets the test binary stand in for claude and codex: run with
// CAPROCK_FAKE_CLI set, it checks the command line a no-tool, no-session,
// structured run needs and answers CAPROCK_FAKE_ANSWER in that CLI's
// format. A Go binary, so the same test runs on Windows. The real CLIs were
// only read through their --help; nothing here runs them.
func TestMain(m *testing.M) {
	if who := os.Getenv("CAPROCK_FAKE_CLI"); who != "" {
		os.Exit(fakeCLI(who, os.Args[1:]))
	}
	os.Exit(m.Run())
}

func fakeCLI(who string, args []string) int {
	in, _ := io.ReadAll(os.Stdin)
	has := func(flag ...string) bool {
		for i := 0; i+len(flag) <= len(args); i++ {
			if slices.Equal(args[i:i+len(flag)], flag) {
				return true
			}
		}
		return false
	}
	after := func(flag string) string {
		for i, a := range args {
			if a == flag && i+1 < len(args) {
				return args[i+1]
			}
		}
		return ""
	}
	if os.Getenv("CAPROCK_FAKE_FAIL") == "1" {
		fmt.Fprintln(os.Stderr, "Not logged in")
		return 1
	}
	answer := os.Getenv("CAPROCK_FAKE_ANSWER")
	if !strings.Contains(string(in), `"message"`) && !strings.Contains(string(in), `"question"`) {
		fmt.Fprintln(os.Stderr, "no context on stdin")
		return 4
	}
	switch who {
	case "claude":
		if !has("-p") || !has("--output-format", "json") || !has("--tools", "") || !has("--strict-mcp-config") ||
			!has("--no-session-persistence") || !has("--setting-sources", "local") || !has("--model", ClaudeModel) ||
			after("--json-schema") == "" || after("--system-prompt") == "" {
			fmt.Fprintln(os.Stderr, "claude: missing a flag:", args)
			return 2
		}
		settings, err := os.ReadFile(after("--settings"))
		if err != nil || !strings.Contains(string(settings), "disableAllHooks") {
			fmt.Fprintln(os.Stderr, "claude: hooks are not off")
			return 2
		}
		if want := os.Getenv("CAPROCK_WANT_DIR"); want != "" && os.Getenv("CLAUDE_CONFIG_DIR") != want {
			fmt.Fprintln(os.Stderr, "claude: wrong CLAUDE_CONFIG_DIR", os.Getenv("CLAUDE_CONFIG_DIR"))
			return 5
		}
		b, _ := json.Marshal(map[string]any{"type": "result", "is_error": false, "result": "", "total_cost_usd": 0.0123,
			"structured_output": json.RawMessage(answer)})
		fmt.Println(string(b))
	case "codex":
		if len(args) == 0 || args[0] != "exec" || !has("--ephemeral") || !has("--ignore-user-config") || !has("--sandbox", "read-only") ||
			!has("--disable", "shell_tool") || !has("--disable", "hooks") || args[len(args)-1] != "-" {
			fmt.Fprintln(os.Stderr, "codex: missing a flag:", args)
			return 2
		}
		if schema, err := os.ReadFile(after("--output-schema")); err != nil || !json.Valid(schema) {
			fmt.Fprintln(os.Stderr, "codex: no schema file")
			return 2
		}
		if want := os.Getenv("CAPROCK_WANT_DIR"); want != "" && os.Getenv("CODEX_HOME") != want {
			fmt.Fprintln(os.Stderr, "codex: wrong CODEX_HOME")
			return 5
		}
		if err := os.WriteFile(after("-o"), []byte(answer+"\n"), 0o600); err != nil {
			return 3
		}
	}
	return 0
}

func fakeRunner(t *testing.T, answer string, extra ...string) CLIRunner {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return CLIRunner{
		Binary: func(string) string { return exe },
		Env: func(set Setting) ([]string, error) {
			env := append(os.Environ(), "CAPROCK_FAKE_CLI="+set.Agent, "CAPROCK_FAKE_ANSWER="+answer)
			return append(env, extra...), nil
		},
		Dir:     t.TempDir(),
		Timeout: 30 * time.Second,
	}
}

func TestEachCLIRunsWithoutToolsAndAnswersInShape(t *testing.T) {
	plan := `{"reply":"On it.","actions":[{"kind":"send","project":"caprock","session_id":"s1","text":"fix it","option":null}]}`
	for _, who := range []string{AgentClaude, AgentCodex} {
		t.Run(who, func(t *testing.T) {
			r := fakeRunner(t, plan)
			res, err := r.Run(context.Background(), Setting{Agent: who}, PlanRequest("fix it", "", Snapshot{}))
			if err != nil {
				t.Fatal(err)
			}
			p, err := ParsePlan(res.JSON)
			if err != nil || p.Reply != "On it." || len(p.Actions) != 1 || p.Actions[0].SessionID != "s1" {
				t.Fatalf("plan %+v err %v", p, err)
			}
			if who == AgentClaude && (!res.CostKnown || res.CostUSD != 0.0123) {
				t.Fatalf("claude's cost was not read: %+v", res)
			}
			if who == AgentCodex && res.CostKnown {
				t.Fatal("codex reports no cost")
			}
		})
	}
}

func TestRunFailureSaysWhy(t *testing.T) {
	for _, who := range []string{AgentClaude, AgentCodex} {
		r := fakeRunner(t, "{}", "CAPROCK_FAKE_FAIL=1")
		_, err := r.Run(context.Background(), Setting{Agent: who}, PlanRequest("x", "", Snapshot{}))
		if err == nil || !strings.Contains(err.Error(), "Not logged in") {
			t.Fatalf("%s: err %v", who, err)
		}
	}
	r := CLIRunner{Binary: func(string) string { return "" }, Dir: t.TempDir()}
	if _, err := r.Run(context.Background(), Setting{Agent: AgentCodex}, Request{}); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("missing binary: %v", err)
	}
}

func TestArgvOnABatchShimKeepsJSONOffTheCommandLine(t *testing.T) {
	args, stdin, err := Argv(AgentClaude, PlanRequest("hi", "", Snapshot{}), true, map[string]string{"settings": "s.json"})
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range args {
		if strings.ContainsAny(a, `{"`) {
			t.Fatalf("JSON on a .cmd command line: %q", a)
		}
	}
	if !strings.Contains(stdin, PlanSchema) || !strings.Contains(stdin, `"message":"hi"`) {
		t.Fatal("the schema and the message must go to stdin")
	}
}

func TestPlanContextCarriesNoPathsOrDetail(t *testing.T) {
	s := Snapshot{
		Agents: []Agent{{SessionID: "s1", Project: "caprock", Dir: "/Users/x/secret-dir", Title: "Fix login", State: "working", Now: "Editing a.go", Controllable: true}},
		Needs:  []Need{{Kind: "question", SessionID: "s1", Project: "caprock", Title: "Which?", Options: []Option{{Label: "A"}, {Label: "B"}}, Answerable: true}},
		Dirs:   map[string]string{"caprock": "/Users/x/dev/caprock"},
	}
	r := PlanRequest("status?", "", s)
	if strings.Contains(r.Prompt, "/Users/") {
		t.Fatalf("a folder path left the machine: %s", r.Prompt)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(r.Prompt), &got); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"message", "needs_you", "agents"} {
		if _, ok := got[k]; !ok {
			t.Fatalf("context lacks %s: %s", k, r.Prompt)
		}
	}
}

func TestParseMention(t *testing.T) {
	ps := []string{"caprock web", "caprock", "api"}
	cases := []struct{ line, project, rest, unknown string }{
		{"@caprock fix the tests", "caprock", "fix the tests", ""},
		{"@caprock web ship the page", "caprock web", "ship the page", ""},
		{"@CAPROCK hi", "caprock", "hi", ""},
		{"@nope do x", "", "do x", "@nope"[1:]},
		{"fix it", "", "fix it", ""},
		{"@caprock", "caprock", "", ""},
	}
	for _, c := range cases {
		p, rest, unk := ParseMention(c.line, ps)
		if p != c.project || rest != c.rest || unk != c.unknown {
			t.Errorf("%q: got (%q, %q, %q)", c.line, p, rest, unk)
		}
	}
}

func TestRouteToPrefersTheNewestOwnedAgent(t *testing.T) {
	s := Snapshot{Agents: []Agent{
		{SessionID: "old", Project: "p", Dir: "/p", Controllable: true, LastActivityAt: 1},
		{SessionID: "new", Project: "p", Controllable: true, LastActivityAt: 5},
		{SessionID: "hand", Project: "p", LastActivityAt: 9},
	}}
	r := RouteTo(s, "p")
	if r.Agent == nil || r.Agent.SessionID != "new" || r.Of != 2 || r.Skipped != 1 || r.Dir != "/p" {
		t.Fatalf("%+v", r)
	}
	r = RouteTo(Snapshot{Dirs: map[string]string{"q": "/q"}}, "q")
	if r.Agent != nil || r.Dir != "/q" {
		t.Fatalf("%+v", r)
	}
	if MostRecentProject([]Agent{{Project: "a", LastActivityAt: 1}, {Project: "b", LastActivityAt: 2}}) != "b" {
		t.Fatal("most recent")
	}
}

func TestDenyWords(t *testing.T) {
	for _, s := range []string{"Push to origin?", "Deploy now", "Deleting the cache", "Send the email", "Use the API token", "force-push", "merge it"} {
		if DenyHit(s) == "" {
			t.Errorf("%q passed the guard", s)
		}
	}
	for _, s := range []string{"Use a table or a list?", "Name it parseRows", "Add a unit test?", "Which layout", "pushover-free naming"} {
		if h := DenyHit(s); h != "" {
			t.Errorf("%q tripped on %q", s, h)
		}
	}
}

func TestEligibleAndRecommended(t *testing.T) {
	n := Need{Kind: "question", Controllable: true, Answerable: true, Options: []Option{{Label: "A"}, {Label: "B"}}}
	if !Eligible(n) {
		t.Fatal("plain question")
	}
	for _, bad := range []Need{
		{Kind: "permission", Controllable: true, Answerable: true, Options: n.Options},
		{Kind: "question", Answerable: true, Options: n.Options},
		{Kind: "question", Controllable: true, Answerable: true, MultiSelect: true, Options: n.Options},
		{Kind: "question", Controllable: true, Answerable: true, MoreQuestions: 1, Options: n.Options},
		{Kind: "question", Controllable: true, Answerable: true, Options: n.Options[:1]},
	} {
		if Eligible(bad) {
			t.Errorf("%+v is not eligible", bad)
		}
	}
	if l, ok := StripRecommended("Use SQLite (Recommended)"); !ok || l != "Use SQLite" {
		t.Fatalf("%q %v", l, ok)
	}
}

func TestParsePlanRefusesUnknownActions(t *testing.T) {
	if _, err := ParsePlan(json.RawMessage(`{"reply":"x","actions":[{"kind":"rm"}]}`)); err == nil {
		t.Fatal("unknown action accepted")
	}
	p, err := ParsePlan(json.RawMessage(`{"reply":"All quiet.","actions":[{"kind":"none","project":null,"session_id":null,"text":null,"option":null}]}`))
	if err != nil || p.Reply != "All quiet." || len(p.Actions) != 0 {
		t.Fatalf("%+v %v", p, err)
	}
}

// --- the engine ---

type harness struct {
	e       *Engine
	snap    Snapshot
	mu      sync.Mutex
	sent    []string
	started []string
	frames  []map[string]any
	answers []string
	handled []Handled
	set     *Setting
	runner  Runner
	now     time.Time
}

func (h *harness) AnswerQuestion(_ context.Context, id string, option int) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.answers = append(h.answers, fmt.Sprintf("%s:%d", id, option))
	return nil
}

func (h *harness) RecordHandled(_ context.Context, it Handled) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.handled = append(h.handled, it)
	return nil
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	h := &harness{now: time.Date(2026, 11, 16, 10, 0, 0, 0, time.Local)}
	h.snap = Snapshot{Agents: []Agent{
		{SessionID: "s1", Project: "caprock", Dir: "/c", Title: "Fix login", State: "idle", Controllable: true, LastActivityAt: 10},
		{SessionID: "s2", Project: "web", Dir: "/w", Title: "Hand-started", State: "working", LastActivityAt: 20},
	}, Dirs: map[string]string{"api": "/a"}}
	h.e = New(context.Background(), Deps{
		DB:       st.DB(),
		Snapshot: func(context.Context) (Snapshot, error) { h.mu.Lock(); defer h.mu.Unlock(); return h.snap, nil },
		Send: func(_ context.Context, id, text string) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.sent = append(h.sent, id+":"+text)
			return nil
		},
		Start: func(_ context.Context, project, dir, text string) (string, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.started = append(h.started, project+":"+dir+":"+text)
			return "new1", nil
		},
		LastWords: func(context.Context, string) string { return "All tests pass.\nSecond line." },
		Runner:    RunnerFunc(func(ctx context.Context, s Setting, r Request) (Result, error) { return h.runner.Run(ctx, s, r) }),
		Setting: func() (Setting, bool) {
			h.mu.Lock()
			defer h.mu.Unlock()
			if h.set == nil {
				return Setting{}, false
			}
			return *h.set, true
		},
		Answer: h, Record: h,
		Publish: func(_ string, data any) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.frames = append(h.frames, data.(map[string]any))
		},
		Now: func() time.Time { h.mu.Lock(); defer h.mu.Unlock(); return h.now },
	})
	return h
}

func (h *harness) setSnap(f func(*Snapshot)) { h.mu.Lock(); f(&h.snap); h.mu.Unlock() }

func TestSayWithoutABrainRoutesDeterministically(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	res, err := h.e.Say(ctx, "@caprock fix the flaky test", "", "voice")
	if err != nil {
		t.Fatal(err)
	}
	if res.Message.Via != "voice" || res.Message.Role != "user" || len(res.Replies) != 1 {
		t.Fatalf("%+v", res)
	}
	if got := res.Replies[0].Text; got != `Gave it to the agent in caprock ("Fix login").` {
		t.Fatalf("reply %q", got)
	}
	if res.Actions[0].Kind != "sent" || h.sent[0] != "s1:fix the flaky test" {
		t.Fatalf("%+v %v", res.Actions, h.sent)
	}
	// web's only agent was started by hand: a new one, never typed into.
	res, _ = h.e.Say(ctx, "add a footer", "web", "")
	if !strings.HasPrefix(res.Replies[0].Text, "No agent was free in web, so I started a new one (the one running there was not started by Caprock") {
		t.Fatalf("reply %q", res.Replies[0].Text)
	}
	if len(h.started) != 1 || h.started[0] != "web:/w:add a footer" {
		t.Fatalf("%v", h.started)
	}
	// No project named: the most recently active one (web).
	res, _ = h.e.Say(ctx, "status", "", "")
	if res.Actions[0].Project != "web" {
		t.Fatalf("%+v", res.Actions)
	}
	res, _ = h.e.Say(ctx, "@nowhere hi", "", "")
	if res.Replies[0].Text != "I do not know a project named nowhere." {
		t.Fatalf("%q", res.Replies[0].Text)
	}
	if _, err := h.e.Say(ctx, "  ", "", ""); !errors.Is(err, ErrInput) {
		t.Fatalf("empty: %v", err)
	}
	msgs, err := h.e.Thread(ctx, 200)
	if err != nil || len(msgs) != 8 || msgs[0].Text != "@caprock fix the flaky test" {
		t.Fatalf("%d %v", len(msgs), err)
	}
}

func waitFor(t *testing.T, what string, f func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if f() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestSayWithTheBrainCarriesOutCheckedActions(t *testing.T) {
	h := newHarness(t)
	h.set = &Setting{Agent: AgentClaude, AutoAnswer: AutoRoutine}
	// The brain tries the hand-started agent and the owned one: only the
	// owned one gets it (rule 7).
	h.runner = RunnerFunc(func(_ context.Context, _ Setting, r Request) (Result, error) {
		if !strings.Contains(r.Prompt, `"message":"tell both to rebase"`) {
			return Result{}, errors.New("no message")
		}
		return Result{CostUSD: 0.02, CostKnown: true, JSON: json.RawMessage(`{"reply":"Asked them to rebase.","actions":[` +
			`{"kind":"send","project":null,"session_id":"s2","text":"rebase on master","option":null},` +
			`{"kind":"send","project":null,"session_id":"s1","text":"rebase on master","option":null}]}`)}, nil
	})
	res, err := h.e.Say(context.Background(), "tell both to rebase", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Replies[0].Pending {
		t.Fatal("a brain reply starts pending")
	}
	id := res.Replies[0].ID
	var final map[string]any
	waitFor(t, "the settled reply", func() bool {
		h.mu.Lock()
		defer h.mu.Unlock()
		for _, f := range h.frames {
			if m, ok := f["message"].(Message); ok && m.ID == id && !m.Pending {
				final = f
				return true
			}
		}
		return false
	})
	m := final["message"].(Message)
	if !strings.HasPrefix(m.Text, "Asked them to rebase. Caprock did not start the agent in web") || m.CostUSD == nil || *m.CostUSD != 0.02 {
		t.Fatalf("%+v", m)
	}
	if len(h.sent) != 1 || h.sent[0] != "s1:rebase on master" {
		t.Fatalf("sent %v", h.sent)
	}
	st := h.e.Status(context.Background())
	if st.State != StateReady || st.RunsToday != 1 || st.SpentTodayUSD != 0.02 {
		t.Fatalf("%+v", st)
	}
}

func TestABrainFailureFallsBackHonestly(t *testing.T) {
	h := newHarness(t)
	h.set = &Setting{Agent: AgentCodex}
	h.runner = RunnerFunc(func(context.Context, Setting, Request) (Result, error) {
		return Result{}, errors.New("codex: Not logged in")
	})
	res, _ := h.e.Say(context.Background(), "@caprock run the tests", "", "")
	waitFor(t, "the fallback", func() bool {
		msgs, _ := h.e.Thread(context.Background(), 10)
		return len(msgs) == 2 && !msgs[1].Pending
	})
	msgs, _ := h.e.Thread(context.Background(), 10)
	want := `The brain did not answer (codex: Not logged in), so I routed it myself: Gave it to the agent in caprock ("Fix login").`
	if msgs[1].Text != want || msgs[1].ID != res.Replies[0].ID {
		t.Fatalf("%q", msgs[1].Text)
	}
	if st := h.e.Status(context.Background()); st.State != StateError || !strings.Contains(st.Note, "Not logged in") {
		t.Fatalf("%+v", st)
	}
}

func TestDoneMessageAfterTheAgentWorkedAndStopped(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := h.e.Say(ctx, "@caprock fix it", "", ""); err != nil {
		t.Fatal(err)
	}
	h.e.Tick(ctx) // still idle: the message has not gone in yet
	h.setSnap(func(s *Snapshot) { s.Agents[0].State = "working" })
	h.e.Tick(ctx)
	h.setSnap(func(s *Snapshot) { s.Agents[0].State = "idle" })
	h.e.Tick(ctx)
	msgs, _ := h.e.Thread(ctx, 10)
	last := msgs[len(msgs)-1]
	if last.Text != "Done: Fix login in caprock finished. Last words: All tests pass. Second line." || last.SessionID != "s1" {
		t.Fatalf("%q", last.Text)
	}
	if h.e.Busy() {
		t.Fatal("the watch should be settled")
	}
}

func questionSnap(s *Snapshot, title string, opts ...Option) {
	s.Needs = []Need{{Kind: "question", SessionID: "s1", Project: "caprock", Title: title, Controllable: true, Answerable: true, Options: opts}}
}

func TestAutoAnswerRoutineQuestion(t *testing.T) {
	h := newHarness(t)
	h.set = &Setting{Agent: AgentClaude, AutoAnswer: AutoRoutine}
	calls := 0
	h.runner = RunnerFunc(func(_ context.Context, _ Setting, r Request) (Result, error) {
		calls++
		if r.Schema != ChoiceSchema || !strings.Contains(r.Prompt, `"recommended":true`) {
			return Result{}, errors.New("not a choice request")
		}
		return Result{CostUSD: 0.01, CostKnown: true, JSON: json.RawMessage(`{"routine":true,"option":1,"reason":"Naming only; the agent recommends it."}`)}, nil
	})
	h.setSnap(func(s *Snapshot) {
		questionSnap(s, "Which name for the helper?", Option{Label: "rowsOf"}, Option{Label: "parseRows", Recommended: true})
	})
	h.e.Tick(context.Background())
	waitFor(t, "the answer", func() bool { h.mu.Lock(); defer h.mu.Unlock(); return len(h.handled) == 1 })
	if h.answers[0] != "s1:1" || h.handled[0].Kind != "auto_answer" || h.handled[0].Text != `Answered "Which name for the helper?" with "parseRows"` {
		t.Fatalf("%v %+v", h.answers, h.handled)
	}
	// The same dialog is considered once.
	h.e.Tick(context.Background())
	time.Sleep(50 * time.Millisecond)
	if calls != 1 {
		t.Fatalf("asked %d times", calls)
	}
}

func TestAutoAnswerNeverOnADenyWord(t *testing.T) {
	h := newHarness(t)
	h.set = &Setting{Agent: AgentClaude, AutoAnswer: AutoRoutine}
	h.runner = RunnerFunc(func(context.Context, Setting, Request) (Result, error) {
		return Result{JSON: json.RawMessage(`{"routine":true,"option":0,"reason":"fine"}`)}, nil
	})
	h.setSnap(func(s *Snapshot) {
		questionSnap(s, "Ready to finish?", Option{Label: "Push to origin (Recommended)", Recommended: true}, Option{Label: "Wait"})
	})
	h.e.Tick(context.Background())
	time.Sleep(50 * time.Millisecond)
	if len(h.answers) != 0 {
		t.Fatalf("pressed %v", h.answers)
	}
}

func TestAutoAnswerOffAndNotRoutine(t *testing.T) {
	h := newHarness(t)
	h.set = &Setting{Agent: AgentClaude, AutoAnswer: AutoOff}
	ran := false
	h.runner = RunnerFunc(func(context.Context, Setting, Request) (Result, error) {
		ran = true
		return Result{JSON: json.RawMessage(`{"routine":false,"option":null,"reason":"It is about priorities."}`)}, nil
	})
	h.setSnap(func(s *Snapshot) { questionSnap(s, "Which feature first?", Option{Label: "A"}, Option{Label: "B"}) })
	h.e.Tick(context.Background())
	time.Sleep(30 * time.Millisecond)
	if ran {
		t.Fatal("auto_answer off still asked the brain")
	}
	h.mu.Lock()
	h.set.AutoAnswer = AutoRoutine
	h.mu.Unlock()
	h.e.Tick(context.Background())
	waitFor(t, "the note", func() bool {
		msgs, _ := h.e.Thread(context.Background(), 10)
		return len(msgs) == 1
	})
	msgs, _ := h.e.Thread(context.Background(), 10)
	if !strings.HasPrefix(msgs[0].Text, `Left a question in caprock for you: "Which feature first?". It is about priorities.`) || len(h.answers) != 0 {
		t.Fatalf("%q %v", msgs[0].Text, h.answers)
	}
}

func TestStatusStates(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if st := h.e.Status(ctx); st.State != StateUnchosen || st.AutoAnswer != AutoRoutine {
		t.Fatalf("%+v", st)
	}
	h.set = &Setting{Agent: AgentOff, AutoAnswer: AutoOff}
	if st := h.e.Status(ctx); st.State != StateOff || st.AutoAnswer != AutoOff {
		t.Fatalf("%+v", st)
	}
	h.set = &Setting{Agent: AgentClaude, Sub: "ab12cd34", AutoAnswer: AutoRoutine}
	h.e.d.Check = func(Setting) (string, string) { return StateSignedOut, "signed out" }
	if st := h.e.Status(ctx); st.State != StateSignedOut || st.Agent != AgentClaude || st.Sub != "ab12cd34" {
		t.Fatalf("%+v", st)
	}
	// Signed out: a message falls back to routing at once, no pending reply.
	res, _ := h.e.Say(ctx, "@caprock hi", "", "")
	if res.Replies[0].Pending {
		t.Fatal("a signed-out brain must not be asked")
	}
}

func TestSettingNormalize(t *testing.T) {
	s, err := Setting{Agent: "claude"}.Normalize()
	if err != nil || s.AutoAnswer != AutoRoutine {
		t.Fatalf("%+v %v", s, err)
	}
	for _, bad := range []Setting{{Agent: "gemini"}, {Agent: "claude", AutoAnswer: "always"}, {Agent: "claude", Sub: "../x"}, {Agent: "claude", Sub: "deepseek"}} {
		if _, err := bad.Normalize(); err == nil {
			t.Errorf("%+v accepted", bad)
		}
	}
}

func TestSettleTurnsPendingIntoANote(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := store.AppendJarvisMessage(ctx, h.e.d.DB, store.JarvisMessage{At: 1, Role: "jarvis", Kind: "reply", Text: "Thinking…", Pending: true}); err != nil {
		t.Fatal(err)
	}
	h.e.Settle(ctx)
	msgs, _ := h.e.Thread(ctx, 5)
	if msgs[0].Pending || msgs[0].Text != RestartNote {
		t.Fatalf("%+v", msgs[0])
	}
}
