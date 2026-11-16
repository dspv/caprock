package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// answeringAgents is fakeAgents that also answers question dialogs,
// recording what it was asked to press.
type answeringAgents struct {
	*fakeAgents
	asked []string
	err   error
}

func (a *answeringAgents) AnswerQuestion(id string, input json.RawMessage, option int, text string) error {
	if a.err != nil {
		return a.err
	}
	d, _ := agents.ParseQuestion(input)
	a.asked = append(a.asked, id+"|"+d.Question+"|"+string(rune('0'+option))+"|"+text)
	return nil
}

const dbAsk = `{"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which database?","options":[` +
	`{"label":"SQLite","description":"One file"},{"label":"Postgres (Recommended)","description":"What prod runs"}]}]}}`

// questionFixture is a Claude Code session Caprock started, at a question
// dialog, and another started by hand at the same dialog.
func questionFixture(t *testing.T) (*jarvisFixture, *answeringAgents) {
	f := newJarvisFixture(t)
	aa := &answeringAgents{fakeAgents: &fakeAgents{avail: true, held: map[string]bool{"mine": true}}}
	f.deps.Agents = aa
	for _, id := range []string{"mine", "theirs"} {
		f.session(id, "caprock", "claude", time.Hour)
		f.add(id, time.Minute, event.Event{Kind: event.KindPermissionPrompt, Tool: "AskUserQuestion", Payload: json.RawMessage(dbAsk)})
	}
	if err := store.MarkOwned(context.Background(), f.st.DB(), "mine", "", "claude", 1); err != nil {
		t.Fatal(err)
	}
	return f, aa
}

func (f *jarvisFixture) answer(body string) (int, string) {
	f.t.Helper()
	if f.srv == nil {
		f.srv = New(f.deps)
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/jarvis/answer", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	f.srv.ServeHTTP(rr, req)
	return rr.Code, rr.Body.String()
}

// A question need carries its options, the recommended one marked and its
// marker taken out of the label; only the one Caprock started is answerable.
func TestJarvisQuestionOptions(t *testing.T) {
	f, _ := questionFixture(t)
	d := f.get()
	if len(d.NeedsYou) != 2 {
		t.Fatalf("needs_you %+v", d.NeedsYou)
	}
	for _, n := range d.NeedsYou {
		// Label is not sent: the shown one (Display) goes as "label".
		want := []agents.QuestionOption{
			{Display: "SQLite", Description: "One file"},
			{Display: "Postgres", Description: "What prod runs", Recommended: true},
		}
		if len(n.Options) != 2 || n.Options[0] != want[0] || n.Options[1] != want[1] || n.MoreQuestions != 0 {
			t.Fatalf("%s options %+v", n.SessionID, n.Options)
		}
		if n.Answerable != (n.SessionID == "mine") {
			t.Fatalf("%s answerable = %v", n.SessionID, n.Answerable)
		}
	}
	// On the wire: label is the shown one, with recommended beside it.
	rr := httptest.NewRecorder()
	f.srv.ServeHTTP(rr, httptest.NewRequest("GET", "/v1/jarvis", nil))
	if !strings.Contains(rr.Body.String(), `"options":[{"label":"SQLite","description":"One file","recommended":false},{"label":"Postgres","description":"What prod runs","recommended":true}],"answerable":`) {
		t.Fatalf("wire: %s", rr.Body.String())
	}
}

// Several questions in one dialog: the first one's options, how many more,
// and no tap.
func TestJarvisSeveralQuestionsAreNotAnswerable(t *testing.T) {
	f := newJarvisFixture(t)
	f.deps.Agents = &answeringAgents{fakeAgents: &fakeAgents{avail: true, held: map[string]bool{"mine": true}}}
	f.session("mine", "caprock", "claude", time.Hour)
	if err := store.MarkOwned(context.Background(), f.st.DB(), "mine", "", "claude", 1); err != nil {
		t.Fatal(err)
	}
	f.add("mine", time.Minute, event.Event{Kind: event.KindPermissionPrompt, Tool: "AskUserQuestion", Payload: json.RawMessage(
		`{"tool_input":{"questions":[{"question":"A?","options":[{"label":"x"},{"label":"y"}]},{"question":"B?","options":[{"label":"z"},{"label":"w"}]}]}}`)})
	n := f.get().NeedsYou[0]
	if n.Answerable || n.MoreQuestions != 1 || len(n.Options) != 2 {
		t.Fatalf("%+v", n)
	}
	if code, _ := f.answer(`{"session_id":"mine","option":0}`); code != 422 {
		t.Fatalf("answered a dialog of two questions: %d", code)
	}
}

func TestJarvisAnswer(t *testing.T) {
	f, aa := questionFixture(t)
	if code, body := f.answer(`{"session_id":"mine","option":1}`); code != 200 || body != `{"ok":true}`+"\n" {
		t.Fatalf("%d %s", code, body)
	}
	if code, _ := f.answer(`{"session_id":"mine","text":"MySQL"}`); code != 200 {
		t.Fatalf("text: %d", code)
	}
	if len(aa.asked) != 2 || aa.asked[0] != "mine|Which database?|1|" || aa.asked[1] != "mine|Which database?|0|MySQL" {
		t.Fatalf("asked %q", aa.asked)
	}
	// Rule 7: a session Caprock did not start is never typed into.
	if code, _ := f.answer(`{"session_id":"theirs","option":0}`); code != 403 {
		t.Fatalf("theirs: %d", code)
	}
	if code, _ := f.answer(`{"session_id":"nobody","option":0}`); code != 403 {
		t.Fatalf("unknown: %d", code)
	}
	for _, bad := range []string{`{"session_id":"mine"}`, `{"option":0}`, `{"session_id":"mine","option":-1}`, `nope`} {
		if code, _ := f.answer(bad); code != 400 {
			t.Fatalf("%s: %d", bad, code)
		}
	}
	// The manager finds another dialog on the screen: 409.
	aa.err = agents.ErrQuestionGone
	if code, _ := f.answer(`{"session_id":"mine","option":0}`); code != 409 {
		t.Fatalf("gone: %d", code)
	}
	aa.err = agents.ErrQuestionNotAnswerable
	if code, _ := f.answer(`{"session_id":"mine","option":0}`); code != 422 {
		t.Fatalf("not answerable: %d", code)
	}
	aa.err = nil
	// The session moved on: its newest event is no longer the dialog.
	f.add("mine", 0, event.Event{Kind: event.KindToolPost, Tool: "AskUserQuestion"})
	if code, _ := f.answer(`{"session_id":"mine","option":0}`); code != 409 {
		t.Fatalf("answered already: %d", code)
	}
	if len(aa.asked) != 2 {
		t.Fatalf("typed into a dialog that was gone: %q", aa.asked)
	}
}

// Handled for you: newest first, bounded by since and limit; the digest
// counts today's.
func TestJarvisHandled(t *testing.T) {
	f := newJarvisFixture(t)
	ctx := context.Background()
	for i, it := range []store.HandledItem{
		{At: f.now.Add(-48 * time.Hour).UnixMilli(), Kind: store.HandledMorning, Text: "Sent the morning summary to Telegram"},
		{At: f.now.Add(-time.Minute).UnixMilli(), Kind: store.HandledLimitSwitch, SessionID: "s1", Project: "caprock", Text: "Moved to Kimi at the usage limit",
			Undo: &store.HandledUndo{Kind: store.HandledUndoContinueOn, SessionID: "s1", Target: "default"}},
	} {
		if _, err := store.AddHandled(ctx, f.st.DB(), it); err != nil {
			t.Fatal(i, err)
		}
	}
	if f.srv == nil {
		f.srv = New(f.deps)
	}
	read := func(q string) []store.HandledItem {
		rr := httptest.NewRecorder()
		f.srv.ServeHTTP(rr, httptest.NewRequest("GET", "/v1/jarvis/handled"+q, nil))
		var out struct {
			Items []store.HandledItem `json:"items"`
		}
		if rr.Code != 200 || json.Unmarshal(rr.Body.Bytes(), &out) != nil || out.Items == nil {
			t.Fatalf("%s: %d %s", q, rr.Code, rr.Body.String())
		}
		return out.Items
	}
	if all := read(""); len(all) != 2 || all[0].Kind != store.HandledLimitSwitch || all[0].Undo == nil || all[0].Undo.Target != "default" {
		t.Fatalf("all %+v", all)
	}
	if got := read("?since=" + itoa(f.now.Add(-time.Hour).UnixMilli())); len(got) != 1 {
		t.Fatalf("since %+v", got)
	}
	if got := read("?limit=1"); len(got) != 1 {
		t.Fatalf("limit %+v", got)
	}
	if got := read("?since=" + itoa(f.now.UnixMilli())); len(got) != 0 {
		t.Fatalf("none %+v", got)
	}
	if d := f.get(); d.HandledToday != 1 {
		t.Fatalf("handled_today %d", d.HandledToday)
	}
}
