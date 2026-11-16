package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/jarvisbrain"
	"github.com/dspv/caprock/internal/store"
)

// jarvisChat is a Jarvis fixture with the chat on: a queue, an agent
// manager holding the owned sessions, settings and a brain runner.
type jarvisChat struct {
	*jarvisFixture
	q      *fakeQueue
	agents *fakeAgents
	set    *fakeSettings
	runner jarvisbrain.Runner
	check  string
}

func newJarvisChat(t *testing.T) *jarvisChat {
	f := &jarvisChat{jarvisFixture: newJarvisFixture(t), q: &fakeQueue{}, agents: &fakeAgents{avail: true, held: map[string]bool{}}, set: &fakeSettings{}}
	f.deps.Queue, f.deps.Agents, f.deps.Settings = f.q, f.agents, f.set
	f.deps.JarvisBrain = &JarvisBrainDeps{
		Runner: jarvisbrain.RunnerFunc(func(ctx context.Context, s jarvisbrain.Setting, r jarvisbrain.Request) (jarvisbrain.Result, error) {
			return f.runner.Run(ctx, s, r)
		}),
		Setting: func() (jarvisbrain.Setting, bool) {
			if jb := f.set.cur.JarvisBrain; jb != nil {
				return *jb, true
			}
			return jarvisbrain.Setting{}, false
		},
		Check:   func(jarvisbrain.Setting) (string, string) { return f.check, "" },
		Context: context.Background(),
	}
	return f
}

func (f *jarvisChat) owned(id, project string) {
	f.t.Helper()
	f.session(id, project, "claude", time.Hour)
	if err := store.MarkOwned(context.Background(), f.st.DB(), id, "", "claude", 1); err != nil {
		f.t.Fatal(err)
	}
	f.agents.held[id] = true
}

func (f *jarvisChat) do(method, path, body string) (int, []byte) {
	f.t.Helper()
	if f.srv == nil {
		f.srv = New(f.deps)
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	f.srv.ServeHTTP(rr, req)
	return rr.Code, rr.Body.Bytes()
}

func TestJarvisSayRoutesToTheOwnedAgent(t *testing.T) {
	f := newJarvisChat(t)
	f.owned("s1", "caprock")
	code, body := f.do("POST", "/v1/jarvis/say", `{"text":"@caprock run the tests","via":"voice"}`)
	if code != 200 {
		t.Fatalf("%d %s", code, body)
	}
	var res jarvisbrain.SayResult
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatal(err)
	}
	if res.Message.Role != "user" || res.Message.Via != "voice" || len(res.Replies) != 1 || len(res.Actions) != 1 {
		t.Fatalf("%s", body)
	}
	if res.Actions[0].Kind != "sent" || res.Actions[0].SessionID != "s1" || len(f.q.sent) != 1 || f.q.sent[0] != "run the tests" {
		t.Fatalf("%s %v", body, f.q.sent)
	}
	if !strings.HasPrefix(res.Replies[0].Text, "Gave it to the agent in caprock") {
		t.Fatalf("%q", res.Replies[0].Text)
	}
	code, body = f.do("GET", "/v1/jarvis/thread?limit=10", "")
	var th struct {
		Messages []jarvisbrain.Message `json:"messages"`
	}
	if code != 200 || json.Unmarshal(body, &th) != nil || len(th.Messages) != 2 || th.Messages[0].ID >= th.Messages[1].ID {
		t.Fatalf("%d %s", code, body)
	}
	if code, _ := f.do("GET", "/v1/jarvis/thread?limit=500", ""); code != 400 {
		t.Fatalf("limit 500: %d", code)
	}
	if code, _ := f.do("POST", "/v1/jarvis/say", `{"text":""}`); code != 400 {
		t.Fatalf("empty: %d", code)
	}
}

// A project with no agent Caprock started gets a new one in its folder.
func TestJarvisSayStartsAnAgentInTheProjectFolder(t *testing.T) {
	f := newJarvisChat(t)
	f.session("hand", "web", "claude", time.Hour) // started by hand: never typed into
	code, body := f.do("POST", "/v1/jarvis/say", `{"text":"add a footer","project":"web"}`)
	if code != 200 {
		t.Fatalf("%d %s", code, body)
	}
	if len(f.q.sent) != 0 || len(f.agents.spawns) != 1 || f.agents.spawns[0]["cwd"] != "/work/web" || f.agents.spawns[0]["prompt"] != "add a footer" {
		t.Fatalf("sent %v spawns %v", f.q.sent, f.agents.spawns)
	}
	if !bytes.Contains(body, []byte("No agent was free in web, so I started a new one")) {
		t.Fatalf("%s", body)
	}
}

// The setting round-trips, null forgets it, and the digest reports the
// brain's state.
func TestJarvisBrainSettingAndDigestState(t *testing.T) {
	f := newJarvisChat(t)
	if d := f.get(); d.Brain.State != jarvisbrain.StateUnchosen {
		t.Fatalf("%+v", d.Brain)
	}
	if code, body := f.do("PUT", "/v1/settings", `{"jarvis_brain":{"agent":"gemini"}}`); code != 400 {
		t.Fatalf("%d %s", code, body)
	}
	code, body := f.do("PUT", "/v1/settings", `{"jarvis_brain":{"agent":"claude","sub":"ab12cd34"}}`)
	if code != 200 || !bytes.Contains(body, []byte(`"jarvis_brain":{"agent":"claude","sub":"ab12cd34","auto_answer":"routine"}`)) {
		t.Fatalf("%d %s", code, body)
	}
	if d := f.get(); d.Brain.State != jarvisbrain.StateReady || d.Brain.Agent != "claude" || d.Brain.Sub != "ab12cd34" {
		t.Fatalf("%+v", d.Brain)
	}
	f.check = jarvisbrain.StateSignedOut
	if d := f.get(); d.Brain.State != jarvisbrain.StateSignedOut {
		t.Fatalf("%+v", d.Brain)
	}
	code, body = f.do("PUT", "/v1/settings", `{"jarvis_brain":null}`)
	if code != 200 || bytes.Contains(body, []byte("jarvis_brain")) {
		t.Fatalf("%d %s", code, body)
	}
}

// With the brain ready, the reply comes later; a question on screen reaches
// the brain with its options.
func TestJarvisSayAsksTheBrainWithTheQuestionOptions(t *testing.T) {
	f := newJarvisChat(t)
	f.owned("q", "caprock")
	f.add("q", time.Minute, event.Event{Kind: event.KindPermissionPrompt, Tool: "AskUserQuestion",
		Payload: json.RawMessage(`{"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which database?","options":[{"label":"SQLite (Recommended)","description":"Local"},{"label":"Postgres"}]}]}}`)})
	jb := jarvisbrain.Setting{Agent: "claude", AutoAnswer: "routine"}
	f.set.cur.JarvisBrain = &jb
	got := make(chan string, 1)
	f.runner = jarvisbrain.RunnerFunc(func(_ context.Context, _ jarvisbrain.Setting, r jarvisbrain.Request) (jarvisbrain.Result, error) {
		got <- r.Prompt
		return jarvisbrain.Result{JSON: json.RawMessage(`{"reply":"One question waits in caprock.","actions":[]}`)}, nil
	})
	code, body := f.do("POST", "/v1/jarvis/say", `{"text":"what is going on?"}`)
	if code != 200 || !bytes.Contains(body, []byte(`"pending":true`)) {
		t.Fatalf("%d %s", code, body)
	}
	var prompt string
	select {
	case prompt = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("the brain was not asked")
	}
	if !strings.Contains(prompt, `"options":[{"label":"SQLite","description":"Local","recommended":true},{"label":"Postgres","recommended":false}]`) ||
		!strings.Contains(prompt, `"answerable":true`) || strings.Contains(prompt, "/work/") {
		t.Fatalf("context: %s", prompt)
	}
}
