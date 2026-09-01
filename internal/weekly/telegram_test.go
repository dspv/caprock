package weekly

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSendPostsToTheUsersBot(t *testing.T) {
	var gotPath string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	s := &Sender{Base: srv.URL}
	if err := s.Send(context.Background(), "123:ABC", "-100999", "hello"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(gotPath, "/bot123:ABC/sendMessage") {
		t.Errorf("path %q", gotPath)
	}
	if body["text"] != "hello" || body["chat_id"] != "-100999" {
		t.Errorf("body %+v", body)
	}
	// No parse mode: a repository name with an underscore would break Markdown
	// or silently italicise half the message.
	if _, ok := body["parse_mode"]; ok {
		t.Error("a parse mode was set; plain text always renders")
	}
}

// Telegram answers 200 with ok:false as readily as it uses a status code, and
// its own words are the ones the user can act on.
func TestSendReportsTelegramsOwnWords(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":false,"description":"chat not found"}`))
	}))
	defer srv.Close()

	err := (&Sender{Base: srv.URL}).Send(context.Background(), "t", "c", "hi")
	if err == nil || !strings.Contains(err.Error(), "chat not found") {
		t.Errorf("error should carry Telegram's own words, got: %v", err)
	}
}

func TestSendRefusesWithoutConfiguration(t *testing.T) {
	if err := (&Sender{}).Send(context.Background(), "", "c", "hi"); err == nil {
		t.Error("sent with no token")
	}
	if err := (&Sender{}).Send(context.Background(), "t", "", "hi"); err == nil {
		t.Error("sent with no chat")
	}
}

var msgEnd = time.Date(2026, 9, 7, 0, 0, 0, 0, time.UTC)

// A quiet week is a result, not an empty message. "Nothing moved" is worth
// sending; a report that lists nothing reads as broken.
func TestMessageSaysWhenNothingMoved(t *testing.T) {
	r := Report{
		WeekStart: msgEnd.AddDate(0, 0, -7), WeekEnd: msgEnd,
		CostUSD: 40, PriorUSD: 42, Quiet: true,
		Projects: []ProjectWeek{{Project: "caprock", CostUSD: 40}},
	}
	got := Message(r, "At API list prices.")
	if !strings.Contains(got, "Nothing moved much") {
		t.Errorf("quiet week not stated:\n%s", got)
	}
	if !strings.Contains(got, "about usual") {
		t.Errorf("a week within range should read as usual:\n%s", got)
	}
	// The basis rides in the message, not only on a screen the reader is not
	// looking at.
	if !strings.Contains(got, "list prices") {
		t.Errorf("basis missing:\n%s", got)
	}
}

func TestMessageNamesMovers(t *testing.T) {
	r := Report{
		WeekStart: msgEnd.AddDate(0, 0, -7), WeekEnd: msgEnd,
		CostUSD: 120, PriorUSD: 40,
		Movers: []Move{
			{Project: "hot-repo", ThisUSD: 90, UsualUSD: 12, Multiple: 7.5},
			{Project: "brand-new", ThisUSD: 30, New: true},
		},
		Projects: []ProjectWeek{{Project: "hot-repo", CostUSD: 90}},
	}
	got := Message(r, "")
	if !strings.Contains(got, "7.5× its usual") {
		t.Errorf("multiple not stated:\n%s", got)
	}
	if !strings.Contains(got, "new this week") {
		t.Errorf("a repo with no baseline should read as new, not as a multiple:\n%s", got)
	}
	if !strings.Contains(got, "up from a usual") {
		t.Errorf("the week's own direction is missing:\n%s", got)
	}
}

// A machine that was off did not stop spending; it was off.
func TestMessageForAnEmptyWeek(t *testing.T) {
	r := Report{WeekStart: msgEnd.AddDate(0, 0, -7), WeekEnd: msgEnd, NoData: true}
	got := Message(r, "basis")
	if !strings.Contains(got, "Nothing ran this week") {
		t.Errorf("empty week:\n%s", got)
	}
	if strings.Contains(got, "0%") || strings.Contains(got, "down from") {
		t.Errorf("an empty week must not read as a collapse:\n%s", got)
	}
}
