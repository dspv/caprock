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
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

var t0 = time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)

type env struct {
	st    *store.Store
	eng   *Engine
	now   time.Time
	cfg   config.BrainConfig
	calls int
	reqs  []Request
	seq   int
}

func on() *bool { v := true; return &v }

func newEnv(t *testing.T, run func(r Request) (Result, error)) *env {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e := &env{st: st, now: t0, cfg: config.BrainConfig{Auto: on(), Since: t0.Add(-48 * time.Hour).UnixMilli()}}
	e.eng = &Engine{
		Store: st, Bus: bus.New(), Now: func() time.Time { return e.now },
		Config: func() config.BrainConfig { return e.cfg },
		Runner: RunnerFunc(func(_ context.Context, r Request) (Result, error) {
			e.calls++
			e.reqs = append(e.reqs, r)
			return run(r)
		}),
	}
	return e
}

// session writes a session of prompt/answer pairs, its last event `ago`
// before now, and returns its newest event id.
func (e *env) session(t *testing.T, id, project string, ago time.Duration, turns ...[2]string) int64 {
	t.Helper()
	ctx := context.Background()
	last := e.now.Add(-ago)
	start := last.Add(-time.Duration(len(turns)) * time.Minute)
	if err := store.UpsertSession(ctx, e.st.DB(), id, store.SessionPatch{Project: project, LastEventAt: last.UnixMilli(), StartedAt: start.UnixMilli(), FromHook: true}); err != nil {
		t.Fatal(err)
	}
	var max int64
	for i, tu := range turns {
		e.seq++
		at := start.Add(time.Duration(i) * time.Minute)
		u := event.Event{SessionID: id, Source: event.SourceTranscript, Kind: event.KindTurnUser, Ts: at, Key: fmt.Sprintf("%s-u%d", id, e.seq),
			Payload: []byte(fmt.Sprintf(`{"prompt":%q}`, tu[0]))}
		a := event.Event{SessionID: id, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: at.Add(30 * time.Second), Key: fmt.Sprintf("%s-a%d", id, e.seq),
			Payload: []byte(fmt.Sprintf(`{"text":%q}`, tu[1]))}
		for _, ev := range []*event.Event{&u, &a} {
			n, err := store.InsertEvent(ctx, e.st.DB(), ev)
			if err != nil {
				t.Fatal(err)
			}
			max = n
		}
	}
	return max
}

var long = strings.Repeat("The cache test reads a fixture another test rewrites, so each test now gets its own directory. ", 5)

func twoMemories(Request) (Result, error) {
	return Result{
		Memories: []Memory{
			{Kind: "decision", Title: "## Keep SQLite\nin WAL mode", Summary: "Postgres is too much for one machine.", Topics: []string{"SQLite", "storage"}, Passage: 2},
			{Kind: "finding", Title: "The cache test shared a fixture", Summary: "Each test gets its own directory now.", Topics: []string{"sqlite", "tests"}, Passage: 4, Related: []int{0}},
		},
		Model: "claude-haiku-test", TokensIn: 4000, TokensOut: 200, CostUSD: 0.004,
	}, nil
}

func TestAReadKeepsMemoriesLinkedToTheirProjectAndTopics(t *testing.T) {
	e := newEnv(t, twoMemories)
	max := e.session(t, "s1", "acme-api", 20*time.Minute, [2]string{"Why is the cache test flaky?", long}, [2]string{"What about the cache store?", "Decision: keep SQLite in WAL mode. " + long})
	sub := e.eng.Bus.Subscribe(16)
	defer sub.Unsubscribe()

	n, err := e.eng.Wake(context.Background())
	if err != nil || n != 1 || e.calls != 1 {
		t.Fatalf("wake: read %d, calls %d, err %v", n, e.calls, err)
	}
	if !strings.Contains(e.reqs[0].Prompt, "Project: acme-api") || !strings.Contains(e.reqs[0].Prompt, "[1] User: Why is the cache test flaky?") ||
		!strings.Contains(e.reqs[0].Prompt, "[4] Agent: Decision: keep SQLite") || e.reqs[0].Model != DefaultModel || e.reqs[0].System != System {
		t.Errorf("request:\n%+v", e.reqs[0])
	}
	g, err := store.ReadBrainGraph(context.Background(), e.st.DB(), store.BrainFilter{Summaries: true})
	if err != nil {
		t.Fatal(err)
	}
	// Two memories, the project, three topics (SQLite and sqlite are one).
	if g.Total != 2 || len(g.Nodes) != 6 {
		t.Fatalf("graph: %d memories, %d nodes", g.Total, len(g.Nodes))
	}
	byTitle := map[string]store.BrainNode{}
	for _, n := range g.Nodes {
		byTitle[n.Title] = n
	}
	d := byTitle["Keep SQLite in WAL mode"]
	if d.Manual || d.RunID == 0 || d.Source.SessionID != "s1" || d.Source.Project != "acme-api" || d.Source.EventID != max-2 {
		t.Errorf("provenance: %+v (passage 2 is event %d)", d, max-2)
	}
	if byTitle["The cache test shared a fixture"].Source.EventID != max {
		t.Error("passage 4 is the last answer")
	}
	kinds := map[string]int{}
	for _, ed := range g.Edges {
		kinds[ed.Kind]++
	}
	// 2 to the project, 4 to topics, 1 related.
	if kinds["part_of"] != 6 || kinds["relates"] != 1 {
		t.Errorf("edges: %v", kinds)
	}
	frames := 0
	for len(sub.C) > 0 {
		if f := <-sub.C; f.Type == bus.FrameBrain && f.Data.(map[string]any)["op"] == "added" {
			frames++
			if d := f.Data.(map[string]any); d["session"] != "s1" || d["project"] != "acme-api" {
				t.Errorf("frame %v: want the memory's session and project", d)
			}
		}
	}
	if frames != 2 {
		t.Errorf("%d brain frames, want one per memory", frames)
	}
	runs, _ := store.LastBrainRuns(context.Background(), e.st.DB(), 5)
	if len(runs) != 1 || runs[0].Status != "ok" || runs[0].Nodes != 2 || runs[0].TokensIn != 4000 || runs[0].Model != "claude-haiku-test" || runs[0].ThroughEventID != max {
		t.Errorf("run: %+v", runs)
	}

	// Read once: the next wake has nothing to do.
	if n, _ := e.eng.Wake(context.Background()); n != 0 || e.calls != 1 {
		t.Errorf("second wake read %d", n)
	}
	// New prose in the same session is read from where the last read stopped.
	e.now = e.now.Add(time.Hour)
	e.session(t, "s1", "acme-api", 15*time.Minute, [2]string{"And retries?", long})
	if n, _ := e.eng.Wake(context.Background()); n != 1 || strings.Contains(e.reqs[1].Prompt, "flaky") {
		t.Errorf("a continued session: read %d, prompt %q", n, e.reqs[1].Prompt)
	}
}

func TestOnlyWhenChosenQuietAndWorthIt(t *testing.T) {
	e := newEnv(t, twoMemories)
	e.session(t, "busy", "p", 2*time.Minute, [2]string{"q", long})
	e.session(t, "tiny", "p", time.Hour, [2]string{"q", "Done."})
	e.session(t, "old", "p", 72*time.Hour, [2]string{"q", long})
	ctx := context.Background()

	e.cfg.Auto = nil
	if n, _ := e.eng.Wake(ctx); n != 0 || e.calls != 0 {
		t.Fatal("never before the user says yes")
	}
	// A yes is all it takes: no licence (owner decision, 2026-10-14).
	e.cfg.Auto = on()
	if n, _ := e.eng.Wake(ctx); n != 0 || e.calls != 0 {
		t.Fatalf("read %d: a working session, a one-line answer and one from before it was on are not read", n)
	}
	runs, _ := store.BrainCandidates(ctx, e.st.DB(), 0, e.now.UnixMilli(), 10)
	for _, c := range runs {
		if c.SessionID == "tiny" {
			t.Error("the tiny session is recorded as skipped, not asked about again")
		}
	}
	// A backfill reaches the old one.
	e.cfg.BackfillSince = e.now.Add(-30 * 24 * time.Hour).UnixMilli()
	est, err := e.eng.EstimateFrom(ctx, e.cfg.BackfillSince)
	if err != nil || est.Sessions != 1 || est.Tokens < OverheadTokens || est.Days != 1 {
		t.Fatalf("estimate: %+v %v", est, err)
	}
	if n, _ := e.eng.Wake(ctx); n != 1 {
		t.Fatalf("backfill read %d", n)
	}
}

func TestAFailureIsRecordedAndRetriedLaterThenGivenUp(t *testing.T) {
	fail := true
	e := newEnv(t, func(Request) (Result, error) {
		if fail {
			return Result{TokensIn: 10}, errors.New("claude: exit status 1: Invalid API key")
		}
		return twoMemories(Request{})
	})
	e.session(t, "s", "p", time.Hour, [2]string{"q", long})
	ctx := context.Background()
	if _, err := e.eng.Wake(ctx); err != nil {
		t.Fatalf("a failed read is not a failed wake: %v", err)
	}
	st := e.eng.Status(ctx)
	if !strings.Contains(st.LastError, "Invalid API key") || len(st.Recent) != 1 || st.Recent[0].Status != "failed" {
		t.Fatalf("status after a failure: %+v", st)
	}
	if _, _ = e.eng.Wake(ctx); e.calls != 1 {
		t.Fatal("retried at once; it waits")
	}
	e.now = e.now.Add(16 * time.Minute)
	_, _ = e.eng.Wake(ctx)
	if e.calls != 2 {
		t.Fatal("not retried after the wait")
	}
	for i := 0; i < 10; i++ {
		e.now = e.now.Add(5 * time.Hour)
		_, _ = e.eng.Wake(ctx)
	}
	if e.calls != MaxFailures {
		t.Errorf("%d calls; gives up after %d failures", e.calls, MaxFailures)
	}
	fail = false
	e.now = e.now.Add(5 * time.Hour)
	e.session(t, "s", "p", time.Hour, [2]string{"more", long})
	if _, _ = e.eng.Wake(ctx); e.calls != MaxFailures+1 {
		t.Error("new prose after giving up is read again")
	}
}

func TestTheDailyTokenLimitStopsReads(t *testing.T) {
	e := newEnv(t, func(Request) (Result, error) {
		r, _ := twoMemories(Request{})
		r.TokensIn = 600 // with 200 out: the second read crosses 1000
		return r, nil
	})
	e.cfg.DailyTokens = 1000
	for i := 0; i < 3; i++ {
		e.session(t, fmt.Sprintf("s%d", i), "p", time.Duration(i+1)*time.Hour, [2]string{"q", long})
	}
	ctx := context.Background()
	if n, _ := e.eng.Wake(ctx); n != 2 {
		t.Fatalf("read %d; the second read crosses the limit, the third waits", n)
	}
	if st := e.eng.Status(ctx); st.Spent < 1000 || !strings.Contains(st.LastError, "limit") || st.Pending != 1 {
		t.Errorf("status: %+v", st)
	}
	e.now = e.now.Add(25 * time.Hour)
	if n, _ := e.eng.Wake(ctx); n != 1 {
		t.Errorf("read %d after the day rolled over", n)
	}
}

func TestArgvNeverLoadsHooksOrWritesATranscript(t *testing.T) {
	args, stdin := Argv(Request{System: "sys", Prompt: "the session", Model: "haiku"}, "/d/settings.json", false)
	joined := strings.Join(args, " ")
	for _, want := range []string{"-p", "--output-format json", "--no-session-persistence", "--setting-sources local", "--settings /d/settings.json", "--model haiku", "--system-prompt sys"} {
		if !strings.Contains(joined, want) {
			t.Errorf("argv lacks %q: %v", want, args)
		}
	}
	if i := slices.Index(args, "--tools"); i < 0 || args[i+1] != "" {
		t.Errorf("--tools must be given an empty list: %v", args)
	}
	if stdin != "the session" {
		t.Errorf("stdin = %q", stdin)
	}
	args, stdin = Argv(Request{System: "sys", Prompt: "the session"}, "/d/settings.json", true)
	for _, a := range args {
		if strings.ContainsAny(a, `{"`) {
			t.Errorf("a batch shim's command line carries %q", a)
		}
	}
	if !strings.Contains(stdin, Schema) || !strings.HasPrefix(stdin, "sys") || !strings.HasSuffix(stdin, "the session") {
		t.Errorf("batch stdin: %q", stdin)
	}
}

// The shape claude 2.1.299 printed for `-p --output-format json
// --json-schema …` on 2026-10-14, trimmed; and the same answer as text.
func TestParseResult(t *testing.T) {
	real := `{"type":"result","subtype":"success","is_error":false,"result":"{\"memories\":[]}","structured_output":{"memories":[{"kind":"decision","title":"Use SQLite with WAL for the cache","summary":"Postgres is overkill for one machine.","topics":["sqlite","cache"]}]},"total_cost_usd":0.0011248,"usage":{"input_tokens":2,"cache_creation_input_tokens":4318,"cache_read_input_tokens":0,"output_tokens":522},"modelUsage":{"claude-haiku-5-5":{"inputTokens":2}}}`
	r, err := ParseResult([]byte(real))
	if err != nil || len(r.Memories) != 1 || r.Memories[0].Title != "Use SQLite with WAL for the cache" || r.TokensIn != 4320 || r.TokensOut != 522 || r.Model != "claude-haiku-5-5" || r.CostUSD != 0.0011248 {
		t.Fatalf("%+v %v", r, err)
	}
	text := `{"is_error":false,"result":"Here you go:\n{\"memories\":[{\"kind\":\"idea\",\"title\":\"A {braced} title\",\"summary\":\"s\",\"topics\":[]}]}","usage":{}}`
	if r, err := ParseResult([]byte(text)); err != nil || len(r.Memories) != 1 || r.Memories[0].Title != "A {braced} title" {
		t.Fatalf("text answer: %+v %v", r, err)
	}
	if _, err := ParseResult([]byte(`{"is_error":true,"subtype":"error_during_execution","result":"Invalid API key"}`)); err == nil || !strings.Contains(err.Error(), "Invalid API key") {
		t.Errorf("an error result: %v", err)
	}
	if _, err := ParseResult([]byte("not json")); err == nil {
		t.Error("not JSON is an error")
	}
}

// The real runner against testdata/fakeclaude, which exits 2 when the flags
// that keep hooks off and the transcript unwritten are missing. A fake binary
// proves the argv is built and read, not that claude accepts it: that was
// checked by hand against `claude --help` (runner.go).
func TestClaudeRunnerAgainstTheFakeClaude(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the fake claude")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	root, _ := filepath.Abs("../..")
	cmd := exec.Command("go", "build", "-o", bin, "./testdata/fakeclaude")
	cmd.Dir = root
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake claude: %v\n%s", err, out)
	}
	r := ClaudeRunner{Binary: func() string { return bin }, Dir: filepath.Join(dir, "work"), Timeout: time.Minute}
	in := BuildInput("acme", nil, []store.BrainPassage{
		{EventID: 1, User: true, Text: "Should we keep the cache in SQLite?"},
		{EventID: 2, Text: "Decision: keep SQLite in WAL mode. Postgres is too much for one machine."},
	})
	res, err := r.Run(context.Background(), Request{System: System, Prompt: in.Prompt, Model: "haiku"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Memories) != 1 || res.Memories[0].Kind != "decision" || res.Memories[0].Passage != 2 || !slices.Contains(res.Memories[0].Topics, "sqlite") {
		t.Fatalf("%+v", res)
	}
	if _, err := os.Stat(filepath.Join(dir, "work", "settings.json")); err != nil {
		t.Error("the settings file that turns hooks off is written beside the call")
	}
	t.Setenv("FAKECLAUDE_PRINT_FAIL", "1")
	if _, err := r.Run(context.Background(), Request{System: System, Prompt: in.Prompt}); err == nil || !strings.Contains(err.Error(), "Invalid API key") {
		t.Errorf("a refused login: %v", err)
	}
	if _, err := (ClaudeRunner{Binary: func() string { return "" }}).Run(context.Background(), Request{}); !errors.Is(err, ErrNoClaude) {
		t.Errorf("no claude: %v", err)
	}
}

func TestBuildInputSendsTheOldestThatFitAndSaysWhereItStopped(t *testing.T) {
	var ps []store.BrainPassage
	for i := 0; i < 60; i++ {
		ps = append(ps, store.BrainPassage{EventID: int64(i + 1), Text: fmt.Sprintf("answer %d %s", i, strings.Repeat("x", 3000))})
	}
	in := BuildInput("", []string{"a", "b"}, ps)
	if len(in.Prompt) > MaxInputChars+500 {
		t.Errorf("prompt is %d chars", len(in.Prompt))
	}
	last := in.Passages[len(in.Passages)-1].EventID
	if in.Passages[0].EventID != 1 || !in.Cut || in.Through != last || last >= 60 {
		t.Errorf("kept %d..%d, cut %v, through %d", in.Passages[0].EventID, last, in.Cut, in.Through)
	}
	if !strings.Contains(in.Prompt, "Existing topics: a, b") || !strings.HasPrefix(strings.Split(in.Prompt, "\n[1] ")[1], "Agent: answer 0 ") {
		t.Error("topics and numbering")
	}
	// What fits is sent whole, and nothing is cut.
	small := BuildInput("", nil, ps[:3])
	if small.Cut || small.Through != 3 || len(small.Passages) != 3 {
		t.Errorf("small: cut %v, through %d, %d passages", small.Cut, small.Through, len(small.Passages))
	}
}

func TestAModelCannotCreateAnImportedNote(t *testing.T) {
	e := newEnv(t, func(Request) (Result, error) {
		return Result{Memories: []Memory{{Kind: "note", Title: "A session finding", Summary: "This came from a session, not a vault."}}}, nil
	})
	e.session(t, "s1", "acme-api", 20*time.Minute, [2]string{"Explain it", long})
	if n, err := e.eng.Wake(context.Background()); err != nil || n != 1 {
		t.Fatalf("wake: %d %v", n, err)
	}
	var kind string
	if err := e.st.DB().QueryRow(`SELECT kind FROM brain_nodes WHERE title = 'A session finding'`).Scan(&kind); err != nil || kind != store.BrainIdea {
		t.Fatalf("kind: %s %v", kind, err)
	}
}
