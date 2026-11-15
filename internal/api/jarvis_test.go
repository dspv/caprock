package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/loop"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/store"
)

// jarvisTasks is a task runner with one task in its needs-you column.
type jarvisTasks struct {
	*fakeTasks
	rows []store.TaskRow
}

func (j jarvisTasks) Approvals(context.Context) (any, error) { return j.rows, nil }

type jarvisFixture struct {
	t     *testing.T
	st    *store.Store
	now   time.Time
	loops map[string]*loop.Alert
	deps  Deps
	srv   *Server
}

func newJarvisFixture(t *testing.T) *jarvisFixture {
	e := newEnv(t)
	f := &jarvisFixture{t: t, st: e.st, now: e.now, loops: map[string]*loop.Alert{}}
	f.deps = Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return f.now },
		ActiveLoops: func(id string) *loop.Alert { return f.loops[id] }}
	return f
}

func (f *jarvisFixture) session(id, project, agent string, startedAgo time.Duration) {
	f.t.Helper()
	ctx := context.Background()
	if err := store.UpsertSession(ctx, f.st.DB(), id, store.SessionPatch{Cwd: "/work/" + project, Project: project, Agent: agent,
		StartedAt: f.now.Add(-startedAgo).UnixMilli(), LastEventAt: f.now.Add(-startedAgo).UnixMilli()}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *jarvisFixture) add(id string, ago time.Duration, ev event.Event) {
	f.t.Helper()
	ev.SessionID, ev.Ts = id, f.now.Add(-ago)
	if ev.Source == "" {
		ev.Source = event.SourceHook
	}
	if _, err := store.InsertEvent(context.Background(), f.st.DB(), &ev); err != nil {
		f.t.Fatal(err)
	}
	// The session row moves with its events, as ingest moves it (naming the
	// agent, as every ingest path does).
	s, err := store.GetSession(context.Background(), f.st.DB(), id)
	if err != nil {
		f.t.Fatal(err)
	}
	if err := store.UpsertSession(context.Background(), f.st.DB(), id, store.SessionPatch{LastEventAt: ev.Ts.UnixMilli(), Agent: s.Agent}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *jarvisFixture) get() JarvisDigest {
	f.t.Helper()
	if f.srv == nil {
		f.srv = New(f.deps)
	}
	rr := httptest.NewRecorder()
	f.srv.ServeHTTP(rr, httptest.NewRequest("GET", "/v1/jarvis", nil))
	if rr.Code != 200 {
		f.t.Fatalf("GET /v1/jarvis: %d %s", rr.Code, rr.Body.String())
	}
	var d JarvisDigest
	if err := json.Unmarshal(rr.Body.Bytes(), &d); err != nil {
		f.t.Fatal(err)
	}
	return d
}

// With nothing live the digest is all zeros and empty arrays, never null.
func TestJarvisEmpty(t *testing.T) {
	f := newJarvisFixture(t)
	rr := httptest.NewRecorder()
	New(f.deps).ServeHTTP(rr, httptest.NewRequest("GET", "/v1/jarvis", nil))
	if rr.Code != 200 {
		t.Fatalf("%d", rr.Code)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rr.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"needs_you", "agents", "projects"} {
		if string(raw[k]) != "[]" {
			t.Errorf("%s = %s, want []", k, raw[k])
		}
	}
	d := f.get()
	if d.GeneratedAt != f.now.UnixMilli() || d.Headline != (JarvisHeadline{}) {
		t.Fatalf("empty digest: %+v", d)
	}
}

// The full shape: states, ordering, needs-you items by urgency, the plan from
// the agent's own task list, today's cost and who may be typed into.
func TestJarvisDigest(t *testing.T) {
	f := newJarvisFixture(t)
	held := &fakeAgents{avail: true, held: map[string]bool{"asks": true}}
	f.deps.Agents = held
	f.deps.Tasks = jarvisTasks{fakeTasks: &fakeTasks{}, rows: []store.TaskRow{{ID: "t-7", Title: "Ship the release notes", Status: "needs-you", UpdatedAt: f.now.Add(-time.Hour).UnixMilli()}}}
	cost := func(v float64) *float64 { return &v }

	// A worker editing a file, with a plan: 1 of 3 done, the second in progress.
	f.session("worker", "caprock", "claude", time.Hour)
	f.add("worker", 50*time.Minute, event.Event{Kind: event.KindTurnAssistant, CostUSD: cost(1.25), Model: "claude-sonnet-4-5", Source: event.SourceTranscript})
	f.add("worker", 3*time.Minute, event.Event{Kind: event.KindToolPre, Tool: "TodoWrite", Payload: json.RawMessage(`{"tool_input":{"todos":[
		{"content":"Read the code","status":"completed","activeForm":"Reading the code"},
		{"content":"Write the tests","status":"in_progress","activeForm":"Writing the tests"},
		{"content":"Open the PR","status":"pending","activeForm":"Opening the PR"},
		{"content":"Dropped idea","status":"cancelled","activeForm":"Dropping"}]}}`)})
	f.add("worker", time.Minute, event.Event{Kind: event.KindToolPre, Tool: "Edit", Payload: json.RawMessage(`{"tool_input":{"file_path":"/work/caprock/ui/src/Cockpit.tsx"}}`)})

	// A hand-started session at a permission dialog for a push.
	f.session("perm", "caprock-web", "claude", 2*time.Hour)
	f.add("perm", 10*time.Minute, event.Event{Kind: event.KindPermissionPrompt, Tool: "Bash",
		Payload: json.RawMessage(`{"tool_name":"Bash","tool_input":{"command":"git push origin feat/x","description":"Push the branch"}}`)})

	// A Caprock-held session whose turn ended asking something.
	f.session("asks", "caprock", "claude", 3*time.Hour)
	if err := store.MarkOwned(context.Background(), f.st.DB(), "asks", "", "claude", 1); err != nil {
		t.Fatal(err)
	}
	f.add("asks", 2*time.Minute, event.Event{Kind: event.KindTurnUser})
	f.add("asks", time.Minute, event.Event{Kind: event.KindAgentStop, Payload: json.RawMessage(`{"last_assistant_message":"I found two fixes.\nShould I merge the smaller one first?"}`)})

	// A session stuck repeating a command (a live loop alert).
	f.session("looper", "caprock", "codex", 4*time.Hour)
	f.add("looper", 30*time.Second, event.Event{Kind: event.KindToolPre, Tool: "Bash", Payload: json.RawMessage(`{"tool_input":{"command":"go test ./..."}}`)})
	f.loops["looper"] = &loop.Alert{Kind: "loop", SessionID: "looper", Tool: "Bash", Count: 9, WindowMin: 10, Sample: "go test ./...",
		FirstTs: f.now.Add(-12 * time.Minute), Ts: f.now.Add(-2 * time.Minute)}

	// One quiet for an hour, and one ended (not live).
	f.session("quiet", "notes", "gemini", 5*time.Hour)
	f.add("quiet", time.Hour, event.Event{Kind: event.KindTurnAssistant, Source: event.SourceTranscript})
	f.session("gone", "caprock", "claude", 6*time.Hour)
	if err := store.UpsertSession(context.Background(), f.st.DB(), "gone", store.SessionPatch{Status: store.StatusEnded}); err != nil {
		t.Fatal(err)
	}

	d := f.get()

	if h := d.Headline; h.Live != 5 || h.Working != 1 || h.WaitingYou != 2 || h.Stuck != 1 {
		t.Fatalf("headline: %+v", h)
	}
	if d.Headline.CostTodayUSD != 1.25 || d.Headline.SessionsToday != 5 {
		t.Fatalf("today: $%v over %d sessions", d.Headline.CostTodayUSD, d.Headline.SessionsToday)
	}

	// Agents: waiting (newest activity first), stuck, working, idle.
	var order []string
	byID := map[string]JarvisAgent{}
	for _, a := range d.Agents {
		order = append(order, a.SessionID)
		byID[a.SessionID] = a
	}
	want := []string{"asks", "perm", "looper", "worker", "quiet"}
	if len(order) != len(want) {
		t.Fatalf("agents %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("agents %v, want %v", order, want)
		}
	}
	w := byID["worker"]
	if w.State != JarvisWorking || w.Now != "Editing Cockpit.tsx" || w.Project != "caprock" || w.Dir != "/work/caprock" || w.Agent != "claude" {
		t.Fatalf("worker: %+v", w)
	}
	if w.Plan == nil || *w.Plan != (JarvisPlan{Done: 1, Total: 3, Current: "Write the tests"}) {
		t.Fatalf("worker plan: %+v", w.Plan)
	}
	if w.CostTodayUSD != 1.25 || w.StartedAt != f.now.Add(-time.Hour).UnixMilli() || w.LastActivityAt != f.now.Add(-time.Minute).UnixMilli() {
		t.Fatalf("worker figures: %+v", w)
	}
	if byID["perm"].Plan != nil || byID["perm"].State != JarvisWaiting {
		t.Fatalf("perm: %+v", byID["perm"])
	}
	if byID["looper"].State != JarvisStuck || byID["looper"].Agent != "codex" || byID["quiet"].State != JarvisIdle {
		t.Fatalf("looper %+v quiet %+v", byID["looper"], byID["quiet"])
	}
	// Only the session Caprock started and holds may be typed into.
	for id, a := range byID {
		if a.Controllable != (id == "asks") {
			t.Errorf("%s controllable = %v", id, a.Controllable)
		}
	}

	// Needs you: permission, question, approval, loop.
	if len(d.NeedsYou) != 4 {
		t.Fatalf("needs_you: %+v", d.NeedsYou)
	}
	p, q, ap, lp := d.NeedsYou[0], d.NeedsYou[1], d.NeedsYou[2], d.NeedsYou[3]
	if p.Kind != NeedsPermission || p.SessionID != "perm" || p.Title != "Wants to run: git push origin feat/x" || p.Detail != "Push the branch" ||
		p.Since != f.now.Add(-10*time.Minute).UnixMilli() || p.Controllable || p.Project != "caprock-web" {
		t.Fatalf("permission: %+v", p)
	}
	if q.Kind != NeedsQuestion || q.SessionID != "asks" || q.Title != "Should I merge the smaller one first?" || !q.Controllable {
		t.Fatalf("question: %+v", q)
	}
	if ap.Kind != NeedsApproval || ap.SessionID != "" || ap.ApprovalID != "t-7" || ap.Title != "Task to approve: Ship the release notes" {
		t.Fatalf("approval: %+v", ap)
	}
	if lp.Kind != NeedsLoop || lp.SessionID != "looper" || lp.Title != "Stuck: ran Bash 9 times" || lp.Detail != "go test ./..." ||
		lp.Since != f.now.Add(-12*time.Minute).UnixMilli() {
		t.Fatalf("loop: %+v", lp)
	}

	// Projects, most live first.
	if len(d.Projects) != 3 || d.Projects[0] != (JarvisProjectRow{Name: "caprock", Live: 3, Waiting: 1}) ||
		d.Projects[1] != (JarvisProjectRow{Name: "caprock-web", Live: 1, Waiting: 1}) || d.Projects[2].Name != "notes" {
		t.Fatalf("projects: %+v", d.Projects)
	}
}

// An AskUserQuestion dialog reads as a question, with its options as detail.
func TestJarvisQuestionDialog(t *testing.T) {
	f := newJarvisFixture(t)
	f.session("q", "caprock", "claude", time.Hour)
	f.add("q", time.Minute, event.Event{Kind: event.KindPermissionPrompt, Tool: "AskUserQuestion",
		Payload: json.RawMessage(`{"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which database?","options":[{"label":"SQLite"},{"label":"Postgres"}]}]}}`)})
	d := f.get()
	if len(d.NeedsYou) != 1 {
		t.Fatalf("needs_you: %+v", d.NeedsYou)
	}
	n := d.NeedsYou[0]
	if n.Kind != NeedsQuestion || n.Title != "Which database?" || n.Detail != "Which database?\nSQLite · Postgres" {
		t.Fatalf("question: %+v", n)
	}
	if d.Agents[0].State != JarvisWaiting || d.Headline.WaitingYou != 1 {
		t.Fatalf("agent: %+v", d.Agents[0])
	}
}

// A task list read once is kept until the session's events change.
func TestJarvisPlanFollowsTheEvents(t *testing.T) {
	f := newJarvisFixture(t)
	f.session("s", "caprock", "claude", time.Hour)
	todo := func(ago time.Duration, status string) {
		f.add("s", ago, event.Event{Kind: event.KindToolPre, Tool: "TodoWrite",
			Payload: json.RawMessage(`{"tool_input":{"todos":[{"content":"Only step","status":"` + status + `","activeForm":"Doing it"}]}}`)})
	}
	todo(2*time.Minute, "in_progress")
	if p := f.get().Agents[0].Plan; p == nil || *p != (JarvisPlan{Done: 0, Total: 1, Current: "Only step"}) {
		t.Fatalf("first: %+v", p)
	}
	todo(time.Minute, "completed")
	if p := f.get().Agents[0].Plan; p == nil || *p != (JarvisPlan{Done: 1, Total: 1}) {
		t.Fatalf("after: %+v", p)
	}
}

// An idle agent's narration is its last event in the past tense ("Was
// subagent finished"); the list says Done instead.
func TestJarvisNowIdleIsDone(t *testing.T) {
	act := narrate.Activity{Phrase: "was subagent finished"}
	if got := jarvisNow(act, JarvisIdle, nil); got != "Done" {
		t.Fatalf("idle now = %q, want Done", got)
	}
	if got := jarvisNow(act, JarvisWaiting, nil); got == "Done" {
		t.Fatalf("waiting now = %q, want the narration", got)
	}
}
