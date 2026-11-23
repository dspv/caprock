package brain

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// The flags that keep a read read-only and out of the user's own setup,
// per CLI (ADR-103). A flag dropped here is a read that can act.
func TestReaderArgvAreReadOnly(t *testing.T) {
	codex := CodexArgv("gpt-5-mini", "/w/answer.txt")
	for _, want := range [][]string{{"exec", "--json"}, {"--sandbox", "read-only"}, {"--ephemeral"}, {"--ignore-user-config"}, {"--ignore-rules"},
		{"--skip-git-repo-check"}, {"-c", "web_search=disabled"}, {"--disable", "shell_tool"}, {"--disable", "unified_exec"},
		{"-m", "gpt-5-mini"}, {"-o", "/w/answer.txt", "-"}} {
		if !containsRun(codex, want) {
			t.Errorf("codex argv lacks %v: %v", want, codex)
		}
	}
	if codex[len(codex)-1] != "-" {
		t.Error("codex reads the prompt from stdin")
	}
	if slices.Contains(CodexArgv("", "/o"), "-m") {
		t.Error("no model: codex's own default")
	}

	gem := GeminiArgv("")
	for _, want := range [][]string{{"-o", "json"}, {"--approval-mode", "plan"}, {"--skip-trust"}, {"-e", "none"}, {"--allowed-mcp-server-names", "caprock-none"}} {
		if !containsRun(gem, want) {
			t.Errorf("gemini argv lacks %v: %v", want, gem)
		}
	}
	if slices.Contains(gem, "-m") || slices.Contains(gem, "--yolo") {
		t.Errorf("gemini: %v", gem)
	}

	cur := CursorArgv("sonnet-4", "/w/read-1", false)
	for _, want := range [][]string{{"-p", "--output-format", "json"}, {"--mode", "ask"}, {"--trust"}, {"--workspace", "/w/read-1"}, {"--model", "sonnet-4"}} {
		if !containsRun(cur, want) {
			t.Errorf("cursor argv lacks %v: %v", want, cur)
		}
	}
	old := CursorArgv("", "/w", true)
	if slices.Contains(old, "--mode") || slices.Contains(old, "--trust") || slices.Contains(old, "--workspace") {
		t.Errorf("an older cursor-agent refuses these: %v", old)
	}
	for _, a := range [][]string{cur, old} {
		if slices.Contains(a, "--force") || slices.Contains(a, "-f") || slices.Contains(a, "--yolo") {
			t.Errorf("cursor never runs with --force: %v", a)
		}
	}
	// No CLI is given JSON or quotes on its command line: a Windows .cmd
	// shim cannot carry them. The shape goes into the prompt.
	for _, a := range [][]string{codex, gem, cur} {
		for _, x := range a {
			if strings.ContainsAny(x, `{}"`) {
				t.Errorf("an argument a batch shim would mangle: %q", x)
			}
		}
	}
	if p := structuredPrompt(Request{System: "S", Prompt: "P"}); !strings.HasPrefix(p, "S\n\n") || !strings.Contains(p, Schema) || !strings.HasSuffix(p, "P") {
		t.Errorf("prompt: %q", p)
	}
}

func containsRun(a, run []string) bool {
	for i := 0; i+len(run) <= len(a); i++ {
		if slices.Equal(a[i:i+len(run)], run) {
			return true
		}
	}
	return false
}

const memJSON = `{"memories":[{"kind":"decision","title":"Keep SQLite","summary":"s","topics":["sqlite"],"keywords":["sqlite"],"passage":2}]}`

// What each CLI reports, read from its documented output: Codex's tokens
// from turn.completed (cached is part of input), Gemini's per model, Cursor
// none — UsageReported false and 0, never an estimate.
func TestReaderParsersReadTheReportedUsage(t *testing.T) {
	req := Request{System: System, Prompt: "p", Model: "m1"}
	codexOut := []byte(`{"type":"thread.started","thread_id":"t"}
{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"ignored when -o has it"}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
`)
	res, err := ParseCodex(codexOut, "Sure: "+memJSON, "", nil, req)
	if err != nil || len(res.Memories) != 1 || res.TokensIn != 24763 || res.TokensOut != 122 || !res.UsageReported || res.CostUSD != 0 || res.Model != "m1" {
		t.Errorf("codex: %+v %v", res, err)
	}
	// Without the -o file, the last agent message.
	res, err = ParseCodex([]byte(`{"type":"item.completed","item":{"type":"agent_message","text":`+fmt.Sprintf("%q", memJSON)+`}}`), "", "", nil, req)
	if err != nil || len(res.Memories) != 1 || res.UsageReported {
		t.Errorf("codex from its events: %+v %v", res, err)
	}
	if _, err := ParseCodex([]byte(`{"type":"turn.failed","error":{"message":"Not logged in"}}`), "", "", errors.New("exit status 1"), req); err == nil || !strings.Contains(err.Error(), "Not logged in") {
		t.Errorf("codex failure: %v", err)
	}

	gem := []byte("Loaded cached credentials.\n" + `{"response":` + fmt.Sprintf("%q", memJSON) + `,"stats":{"models":{"gemini-2.5-flash":{"tokens":{"prompt":4000,"candidates":150,"cached":1000,"thoughts":50,"total":4200}}}}}`)
	res, err = ParseGemini(gem, "", nil, Request{System: System, Prompt: "p"})
	if err != nil || len(res.Memories) != 1 || res.TokensIn != 4000 || res.TokensOut != 200 || !res.UsageReported || res.Model != "gemini-2.5-flash" {
		t.Errorf("gemini: %+v %v", res, err)
	}
	if _, err := ParseGemini([]byte(`{"error":{"message":"Please set an Auth method"}}`), "", errors.New("exit status 1"), req); err == nil || !strings.Contains(err.Error(), "Auth method") {
		t.Errorf("gemini failure: %v", err)
	}

	cur := []byte(`{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"duration_api_ms":1,"result":` + fmt.Sprintf("%q", memJSON) + `,"session_id":"s"}`)
	res, err = ParseCursor(cur, "", nil, req)
	if err != nil || len(res.Memories) != 1 || res.UsageReported || res.TokensIn != 0 || res.TokensOut != 0 || res.CostUSD != 0 {
		t.Errorf("cursor: %+v %v", res, err)
	}
	if _, err := ParseCursor(nil, "Authentication required to use Cursor Agent.", errors.New("exit status 1"), req); err == nil || !strings.Contains(err.Error(), "Authentication required") {
		t.Errorf("cursor failure: %v", err)
	}
	// A plain request takes the text as it is.
	res, err = ParseCursor([]byte(`{"result":"One sentence."}`), "", nil, Request{Plain: true})
	if err != nil || res.Text != "One sentence." {
		t.Errorf("plain: %+v %v", res, err)
	}
	if _, err := ParseCursor([]byte(`{"result":"no json here"}`), "", nil, req); err == nil {
		t.Error("an answer without the memories is an error")
	}
}

var (
	fakeOnce sync.Once
	fakeBin  string
	fakeErr  error
)

// fakeReader builds testdata/fakereader once per test binary.
func fakeReader(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("builds the fake reader")
	}
	fakeOnce.Do(func() {
		dir, err := os.MkdirTemp("", "fakereader-")
		if err != nil {
			fakeErr = err
			return
		}
		fakeBin = filepath.Join(dir, "fakereader")
		if runtime.GOOS == "windows" {
			fakeBin += ".exe"
		}
		root, _ := filepath.Abs("../..")
		cmd := exec.Command("go", "build", "-o", fakeBin, "./testdata/fakereader")
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			fakeErr = fmt.Errorf("build fake reader: %w\n%s", err, out)
		}
	})
	if fakeErr != nil {
		t.Fatal(fakeErr)
	}
	return fakeBin
}

// Each runner against a fake CLI: the prompt goes on stdin, the call runs
// in an empty folder of its own that is gone afterwards, and the answer and
// usage come back as ClaudeRunner's do.
func TestReadersAgainstAFakeCLI(t *testing.T) {
	bin := fakeReader(t)
	dir := t.TempDir()
	log := filepath.Join(dir, "log.txt")
	env := func(extra ...string) func() []string {
		return func() []string { return append(append(os.Environ(), "FAKEREADER_LOG="+log), extra...) }
	}
	ctx := context.Background()
	req := Request{System: System, Prompt: "PASSAGES-HERE"}
	runners := map[string]Runner{
		ReaderCodex:  CodexRunner{Binary: func() string { return bin }, Env: env(), Dir: filepath.Join(dir, "codex"), Timeout: time.Minute},
		ReaderGemini: GeminiRunner{Binary: func() string { return bin }, Env: env(), Dir: filepath.Join(dir, "gemini"), Timeout: time.Minute},
		ReaderCursor: &CursorRunner{Binary: func() string { return bin }, Env: env(), Dir: filepath.Join(dir, "cursor"), Timeout: time.Minute},
	}
	for _, id := range []string{ReaderCodex, ReaderGemini, ReaderCursor} {
		res, err := runners[id].Run(ctx, req)
		if err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		if len(res.Memories) != 1 || res.Memories[0].Kind != "decision" || res.Memories[0].Passage != 2 {
			t.Errorf("%s memories: %+v", id, res.Memories)
		}
		if res.UsageReported != ReportsTokens(id) || (res.TokensIn > 0) != ReportsTokens(id) || res.CostUSD != 0 {
			t.Errorf("%s usage: %+v", id, res)
		}
		b, _ := os.ReadFile(log)
		_, stdin, _ := strings.Cut(string(b), "--stdin--\n")
		if !strings.Contains(stdin, "PASSAGES-HERE") || !strings.Contains(stdin, Schema) || strings.Contains(strings.SplitN(string(b), "--stdin--", 2)[0], "PASSAGES-HERE") {
			t.Errorf("%s: the prompt goes on stdin, never the command line:\n%s", id, b)
		}
		left, _ := os.ReadDir(filepath.Join(dir, id))
		for _, f := range left {
			if strings.HasPrefix(f.Name(), "read-") {
				t.Errorf("%s left its call folder %s behind", id, f.Name())
			}
		}
	}

	// A signed-out CLI fails with what it said.
	for _, id := range []string{ReaderCodex, ReaderGemini, ReaderCursor} {
		var r Runner
		switch id {
		case ReaderCodex:
			r = CodexRunner{Binary: func() string { return bin }, Env: env("FAKEREADER_FAIL=auth"), Dir: filepath.Join(dir, "f-"+id)}
		case ReaderGemini:
			r = GeminiRunner{Binary: func() string { return bin }, Env: env("FAKEREADER_FAIL=auth"), Dir: filepath.Join(dir, "f-"+id)}
		default:
			r = &CursorRunner{Binary: func() string { return bin }, Env: env("FAKEREADER_FAIL=auth"), Dir: filepath.Join(dir, "f-"+id)}
		}
		if _, err := r.Run(ctx, req); err == nil || !notSignedIn(strings.ToLower(err.Error())) {
			t.Errorf("%s signed out: %v", id, err)
		}
	}

	// An older cursor-agent refuses --mode: the read is made again without
	// the newer flags, and the runner remembers.
	old := &CursorRunner{Binary: func() string { return bin }, Env: env("FAKEREADER_OLD=1"), Dir: filepath.Join(dir, "old")}
	if res, err := old.Run(ctx, req); err != nil || len(res.Memories) != 1 {
		t.Fatalf("old cursor: %+v %v", res, err)
	}
	if b, _ := os.ReadFile(log); strings.Contains(string(b), "--mode") {
		t.Errorf("the retry has no --mode:\n%s", b)
	}
	if !old.old {
		t.Error("the runner remembers the older CLI")
	}

	// Not installed.
	for _, r := range []Runner{CodexRunner{}, GeminiRunner{}, &CursorRunner{}} {
		if _, err := r.Run(ctx, req); !errors.Is(err, ErrNoReader) {
			t.Errorf("no binary: %v", err)
		}
	}
}

// readersEnv is an engine with a runner per reader that records which one
// was asked; installed says which CLIs are on the machine.
func readersEnv(t *testing.T, installed map[string]bool, answer func(id string) (Result, error)) (*env, *[]string) {
	t.Helper()
	e := newEnv(t, twoMemories)
	asked := &[]string{}
	e.eng.Readers = map[string]Runner{}
	for _, id := range ReaderOrder {
		e.eng.Readers[id] = RunnerFunc(func(_ context.Context, r Request) (Result, error) {
			*asked = append(*asked, id+":"+r.Model)
			return answer(id)
		})
	}
	e.eng.Installed = func(a string) bool { return installed[a] }
	return e, asked
}

func (e *env) agentSessions(t *testing.T, agent string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		e.seq++
		id := fmt.Sprintf("%s-used-%d", agent, e.seq)
		if err := store.UpsertSession(context.Background(), e.st.DB(), id, store.SessionPatch{Agent: agent, LastEventAt: e.now.Add(-50 * time.Hour).UnixMilli(),
			StartedAt: e.now.Add(-51 * time.Hour).UnixMilli(), FromHook: true}); err != nil {
			t.Fatal(err)
		}
	}
}

// Auto reads with the installed agent the user worked in most in the last
// 30 days; Claude Code wins a tie; an agent not installed is never picked.
func TestAutoReadsWithTheAgentUsedMost(t *testing.T) {
	ctx := context.Background()
	e, asked := readersEnv(t, map[string]bool{ReaderClaude: true, ReaderCursor: true, ReaderGemini: false}, func(id string) (Result, error) {
		r, _ := twoMemories(Request{})
		r.Model = ""
		if !ReportsTokens(id) {
			r.TokensIn, r.TokensOut, r.CostUSD = 0, 0, 0
		}
		return r, nil
	})
	if p := e.eng.pick(ctx); p.Reader != ReaderClaude || p.Setting != ReaderAuto {
		t.Errorf("nothing used: claude first, got %+v", p)
	}
	e.agentSessions(t, ReaderCursor, 3)
	e.agentSessions(t, ReaderGemini, 9) // most used, but not installed
	e.agentSessions(t, ReaderClaude, 3)
	if p := e.eng.pick(ctx); p.Reader != ReaderClaude {
		t.Errorf("a tie goes to Claude Code: %+v", p.Reader)
	}
	e.agentSessions(t, ReaderCursor, 5)
	st := e.eng.Status(ctx)
	if st.Reader != ReaderCursor || st.ReaderSetting != ReaderAuto || !st.ReaderFound || st.UsageReported || st.Model != "" || len(st.Readers) != 4 {
		t.Fatalf("cursor used most: %+v", st)
	}

	// A read with Cursor keeps memories, records the reader, and no tokens:
	// it is counted as a read with no usage.
	e.session(t, "s1", "acme", 20*time.Minute, [2]string{"q", long})
	if n, err := e.eng.Wake(ctx); n != 1 || err != nil {
		t.Fatalf("wake: %d %v", n, err)
	}
	if len(*asked) != 1 || (*asked)[0] != "cursor:" {
		t.Errorf("asked %v; Cursor with its own default model", *asked)
	}
	runs, _ := store.LastBrainRuns(ctx, e.st.DB(), 1)
	if len(runs) != 1 || runs[0].Reader != ReaderCursor || !runs[0].NoUsage || runs[0].TokensIn != 0 || runs[0].Nodes != 2 {
		t.Errorf("run: %+v", runs)
	}
	if st := e.eng.Status(ctx); st.NoUsageReads != 1 || st.Spent != 0 {
		t.Errorf("status: no_usage_reads %d spent %d", st.NoUsageReads, st.Spent)
	}

	// A model chosen for Cursor is passed.
	e.cfg.Models = map[string]string{ReaderCursor: "sonnet-4"}
	e.now = e.now.Add(time.Hour)
	e.session(t, "s2", "acme", 20*time.Minute, [2]string{"q", long})
	if n, _ := e.eng.Wake(ctx); n != 1 || (*asked)[1] != "cursor:sonnet-4" {
		t.Errorf("model: %v", *asked)
	}
}

// A reader that reports no tokens is held to the daily reads limit, so the
// daily cap still holds without an estimate.
func TestTheDailyReadsLimitHoldsAReaderThatReportsNoTokens(t *testing.T) {
	ctx := context.Background()
	e, asked := readersEnv(t, map[string]bool{ReaderCursor: true}, func(string) (Result, error) {
		return Result{Memories: []Memory{{Kind: "finding", Title: "A finding", Summary: "s", Topics: []string{"t"}, Keywords: []string{"k"}}}}, nil
	})
	e.cfg.Reader = ReaderCursor
	e.cfg.DailyReads = 2
	for i := 0; i < 3; i++ {
		e.session(t, fmt.Sprintf("s%d", i), "p", time.Duration(i+1)*time.Hour, [2]string{"q", long})
	}
	if n, _ := e.eng.Wake(ctx); n != 2 || len(*asked) != 2 {
		t.Fatalf("read %d; the limit is two reads", n)
	}
	st := e.eng.Status(ctx)
	if st.Stage != StageLimit || !strings.Contains(st.LastError, "reads limit") || st.Pending != 1 {
		t.Errorf("status: stage %q error %q pending %d", st.Stage, st.LastError, st.Pending)
	}
	e.now = e.now.Add(25 * time.Hour)
	if n, _ := e.eng.Wake(ctx); n != 1 {
		t.Errorf("read %d after the day rolled over", n)
	}
}

// With nothing to read with, nothing is tried — no session is recorded as
// failed for want of an agent — and the status says what is needed.
func TestNoReaderTriesNothingAndSaysWhatIsNeeded(t *testing.T) {
	ctx := context.Background()
	e, asked := readersEnv(t, map[string]bool{}, func(string) (Result, error) { return Result{}, nil })
	e.session(t, "s1", "p", time.Hour, [2]string{"q", long})
	if n, _ := e.eng.Wake(ctx); n != 0 || len(*asked) != 0 {
		t.Fatalf("read %d with no agent", n)
	}
	if runs, _ := store.BrainRunsOf(ctx, e.st.DB(), "s1"); len(runs) != 0 {
		t.Errorf("runs recorded: %+v", runs)
	}
	st := e.eng.Status(ctx)
	if st.Stage != StageNoReader || st.ReaderFound || st.Reader != "" || !strings.Contains(st.ReaderProblem, "Claude Code, Codex, Cursor or Gemini CLI") {
		t.Errorf("none installed: %q %q", st.Stage, st.ReaderProblem)
	}
	// The chosen one missing names it.
	e.eng.Installed = func(a string) bool { return a == ReaderClaude }
	e.cfg.Reader = ReaderCodex
	if st := e.eng.Status(ctx); st.Stage != StageNoReader || !strings.HasPrefix(st.ReaderProblem, "Codex was not found") {
		t.Errorf("codex chosen, missing: %q %q", st.Stage, st.ReaderProblem)
	}
}

// A reader whose last calls all failed is failing: the status says so in a
// sentence naming the fix, a wake tries it once rather than four times, and
// Auto passes it over for another installed agent.
func TestAFailingReaderIsSaidAndPassedOver(t *testing.T) {
	ctx := context.Background()
	fail := true
	e, asked := readersEnv(t, map[string]bool{ReaderClaude: true, ReaderCodex: true}, func(id string) (Result, error) {
		if id == ReaderCodex && fail {
			return Result{}, errors.New("codex: Not logged in. Run codex login.")
		}
		return twoMemories(Request{})
	})
	e.cfg.Reader = ReaderCodex
	for i := 0; i < 8; i++ {
		e.session(t, fmt.Sprintf("s%d", i), "p", time.Duration(i+1)*time.Hour, [2]string{"q", long})
	}
	if n, _ := e.eng.Wake(ctx); n != Batch {
		t.Fatalf("first wake: %d calls", n)
	}
	st := e.eng.Status(ctx)
	if st.Stage != StageFailing || !strings.Contains(st.ReaderProblem, "Codex is not signed in") || !strings.Contains(st.ReaderProblem, "choose another agent under Read with") {
		t.Errorf("failing: %q %q", st.Stage, st.ReaderProblem)
	}
	before := len(*asked)
	e.now = e.now.Add(time.Minute)
	if n, _ := e.eng.Wake(ctx); n != 1 || len(*asked) != before+1 {
		t.Errorf("a failing reader is tried once a wake: %d", n)
	}
	// Auto passes it over for Claude Code, though Codex is used more.
	e.agentSessions(t, ReaderCodex, 5)
	e.cfg.Reader = ""
	if p := e.eng.pick(ctx); p.Reader != ReaderClaude || p.Failing || p.Problem != "" {
		t.Errorf("auto: %+v", p)
	}
	// Signed in again and chosen: one read that works clears it.
	fail = false
	e.cfg.Reader = ReaderCodex
	e.now = e.now.Add(2 * time.Hour)
	if n, _ := e.eng.Wake(ctx); n < 1 {
		t.Fatal("no read after signing in")
	}
	if st := e.eng.Status(ctx); st.Stage == StageFailing || st.ReaderProblem != "" {
		t.Errorf("recovered: %q %q", st.Stage, st.ReaderProblem)
	}
}

// Mail's assistant and 2nd Brain turn off the same Codex tools.
func TestCodexDisabledMatchesTheFlagsVerifiedForMail(t *testing.T) {
	b, err := os.ReadFile("../mail/ai/cli.go")
	if err != nil {
		t.Skip(err)
	}
	for _, f := range CodexDisabled {
		if !strings.Contains(string(b), `"`+f+`"`) {
			t.Errorf("%s is not in Mail's list", f)
		}
	}
}
