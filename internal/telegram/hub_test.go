package telegram_test

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/telegram"
)

// link is the machine-to-machine link in one process: a HubClient whose
// requests the holder's ServeHub answers as computer `from`.
func link(holder telegram.Hub, from telegram.Sender) telegram.HubClient {
	return telegram.HubClient{Do: func(r *http.Request) (*http.Response, error) {
		rec := httptest.NewRecorder()
		telegram.ServeHub(holder, from, rec, r)
		return rec.Result(), nil
	}}
}

var macbook = telegram.Sender{ID: "dev-macbook", Name: "MacBook", Key: "key-macbook"}

// sender is a computer with no bot that sends through the holder's.
type sender struct {
	h      *host
	b      *telegram.Bridge
	client telegram.HubClient
}

func newSender(t *testing.T, holder *stand, mut func(*host)) *sender {
	t.Helper()
	h := newHost()
	h.token = ""
	if mut != nil {
		mut(h)
	}
	b := telegram.New(h, t.TempDir(), slog.New(slog.NewTextHandler(&safeBuf{}, nil)))
	c := link(holder.b, macbook)
	b.Via = func() string { return "mini" }
	b.Route = func(m telegram.HubMessage, done func(error)) {
		go func() {
			_, err := c.Post(context.Background(), m)
			done(err)
		}()
	}
	return &sender{h: h, b: b, client: c}
}

// ask delivers an approval alert from the sender, as the daemon builds one.
func (s *sender) ask(t *testing.T, prompt string) {
	t.Helper()
	done := make(chan error, 1)
	s.b.Deliver(telegram.Out{
		Text: "🟠 Claude Code · caprock · Fix the cache test\n⏳ <b>Needs approval</b>", ParseMode: "HTML",
		Markup: &telegram.Markup{InlineKeyboard: [][]telegram.InlineButton{
			{{Text: "✅ Approve", CallbackData: "y"}, {Text: "✖️ Deny", CallbackData: "n"}},
			{{Text: "Open on phone", URL: "https://mini.example/#/session/own"}, {Text: "🔕 Mute this session", CallbackData: "m"}},
		}},
	}, telegram.Ref{SessionID: "own", PromptID: prompt, Kind: "alert"}, func(err error) { done <- err })
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// act takes the presses waiting on the holder, acts on each and reports back.
func (s *sender) act(t *testing.T) []telegram.HubPress {
	t.Helper()
	ps, err := s.client.Presses(context.Background(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range ps {
		if err := s.client.Result(context.Background(), s.b.Act(context.Background(), p)); err != nil {
			t.Fatal(err)
		}
	}
	return ps
}

// A computer with no bot sends its question through the holder: the chat
// sees it under the computer's name with its buttons, a press goes back to
// that computer, which answers its own prompt, and the buttons show the
// outcome.
func TestAnotherComputersQuestionIsAnsweredWhereItWasAsked(t *testing.T) {
	holder := paired(t, nil) // the holder needs no licence: the asker decides
	s := newSender(t, holder, func(h *host) { h.licensed, h.chatOn = true, true })
	if !s.b.Active() {
		t.Fatal("a licensed computer sending through a holder should count as two-way")
	}
	s.ask(t, "p1")
	m := holder.message(1)
	if !strings.HasPrefix(m.Text, "🖥 <b>MacBook</b>\n🟠 Claude Code · caprock") || m.ParseMode != "HTML" {
		t.Fatalf("text = %q (%s)", m.Text, m.ParseMode)
	}
	if strings.Join(m.Buttons, ",") != "h:0,h:1,url:https://mini.example/#/session/own,h:2" {
		t.Fatalf("buttons = %v", m.Buttons)
	}
	if got := holder.b.Status().Carries; len(got) != 1 || got[0].Name != "MacBook" {
		t.Fatalf("carries = %+v", got)
	}

	holder.bot.Press(owner, m.MessageID, "h:0")
	eventually(t, "the toast", func() bool {
		a := holder.bot.Answers()
		return len(a) > 0 && a[len(a)-1] == "Sent to MacBook."
	})
	if ps := s.act(t); len(ps) != 1 || ps[0].Action != telegram.ActApprove {
		t.Fatalf("presses = %+v", ps)
	}
	if got := s.h.answered; len(got) != 1 || got[0] != "own/p1/allow" {
		t.Fatalf("answered = %v", got)
	}
	if len(holder.h.answered) != 0 {
		t.Fatal("the holder answered a prompt of its own")
	}
	eventually(t, "the outcome on the buttons", func() bool {
		for _, x := range holder.bot.Sent() {
			if x.Method == "editMessageReplyMarkup" && x.ReplyTo == m.MessageID && strings.Join(x.Buttons, ",") == "-" {
				return true
			}
		}
		return false
	})
}

// The asking computer's licence and switch decide, not the holder's: an
// unlicensed computer's press is answered with a line, and nothing is
// approved anywhere. Mute is free.
func TestAnAnswerNeedsTheAskingComputersLicence(t *testing.T) {
	holder := paired(t, func(h *host) { h.licensed, h.chatOn = true, true })
	s := newSender(t, holder, nil)
	s.ask(t, "p1")
	m := holder.message(1)
	holder.bot.Press(owner, m.MessageID, "h:1")
	eventually(t, "the toast", func() bool { return len(holder.bot.Answers()) > 0 })
	s.act(t)
	if len(s.h.answered) != 0 || len(holder.h.answered) != 0 {
		t.Fatal("an unlicensed computer's prompt was answered")
	}
	say := holder.message(2)
	if say.ReplyTo != m.MessageID || !strings.Contains(say.Text, "Premium") {
		t.Fatalf("say = %+v", say)
	}
	holder.bot.Press(owner, m.MessageID, "h:2")
	eventually(t, "the second toast", func() bool { return len(holder.bot.Answers()) > 1 })
	s.act(t)
	if !s.b.Muted("own") {
		t.Fatal("mute did not reach the asking computer")
	}
	if holder.b.Muted("own") {
		t.Fatal("the holder muted a session of its own")
	}
}

// A Telegram reply to another computer's message is typed into the session
// there, and the reply gets a 👍.
func TestAReplyGoesToTheComputerThatAsked(t *testing.T) {
	holder := paired(t, nil)
	s := newSender(t, holder, func(h *host) { h.licensed, h.chatOn = true, true })
	s.ask(t, "")
	m := holder.message(1)
	holder.bot.Reply(owner, m.MessageID, "run it with -race")
	eventually(t, "the press", func() bool {
		ps := s.act(t)
		return len(ps) == 1 && ps[0].Action == telegram.ActReply
	})
	if got := s.h.typed["own"]; len(got) != 1 || got[0] != "run it with -race" {
		t.Fatalf("typed = %v", got)
	}
	if len(holder.h.typed) != 0 {
		t.Fatal("the holder typed into a session of its own")
	}
	eventually(t, "the 👍", func() bool {
		for _, x := range holder.bot.Sent() {
			if x.Method == "setMessageReaction" && x.Emoji == "👍" {
				return true
			}
		}
		return false
	})
}

// A post repeated under the same id (a sender that lost the answer) is one
// message; a message that waited says how late it is; a machine with no bot
// refuses with 409.
func TestHubPostIsIdempotentSaysLateAndNeedsABot(t *testing.T) {
	holder := paired(t, nil)
	c := link(holder.b, macbook)
	ctx := context.Background()
	m := telegram.HubMessage{ID: "abc", Text: "plain <words> & more", LateS: 600}
	id1, err := c.Post(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	id2, err := c.Post(ctx, m)
	if err != nil || id1 != id2 {
		t.Fatalf("second post: %d %v (first %d)", id2, err, id1)
	}
	if n := len(holder.bot.Messages()); n != 1 {
		t.Fatalf("%d messages", n)
	}
	if got := holder.message(1).Text; got != "🖥 <b>MacBook</b> · <i>10 min late: this computer was out of reach</i>\nplain &lt;words&gt; &amp; more" {
		t.Fatalf("text = %q", got)
	}

	none := newStand(t, func() *host { h := newHost(); h.token = ""; return h }())
	_, err = link(none.b, macbook).Post(ctx, m)
	if !telegram.NotHolder(err) {
		t.Fatalf("err = %v", err)
	}
	if info, _ := link(none.b, macbook).Info(ctx); info.Holder {
		t.Fatal("a machine with no bot says it holds one")
	}
	if info, _ := c.Info(ctx); !info.Holder {
		t.Fatal("the holder says it holds no bot")
	}
}

// The bot moves to the computer that asks: the old holder forgets it and
// says where it went, the new one carries on with the same chat and offset,
// and the chat hears it moved.
func TestTheBotMovesWithoutANewPairing(t *testing.T) {
	holder := paired(t, nil)
	var moved telegram.Sender
	holder.b.OnMoved = func(to telegram.Sender) { moved = to }
	_ = holder.b.Store.Update(func(st *telegram.State) {
		st.BotID, st.BotUsername, st.ChatID, st.ChatName, st.Offset = 42, "caprock_test_bot", "777", "Owner", 9001
	})
	s := newSender(t, holder, nil)
	h, err := s.client.Handover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if h.Token != token || h.ChatID != "777" || h.Offset != 9001 || h.BotUsername != "caprock_test_bot" || h.ChatName != "Owner" {
		t.Fatalf("handover = %+v", h)
	}
	if tok, chat := holder.h.Bot(); tok != "" || chat != "" {
		t.Fatal("the old holder kept the bot")
	}
	if st := holder.b.Status(); st.MovedTo == nil || st.MovedTo.Name != "MacBook" || st.BotSet {
		t.Fatalf("old holder status = %+v", st)
	}
	if moved.Name != "MacBook" {
		t.Fatalf("OnMoved heard %+v", moved)
	}

	// The new holder, on the same (fake) Telegram.
	s.b.Base = holder.bot.URL()
	s.b.Out.Gap = 10 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go s.b.Run(ctx)
	if err := s.b.TakeOver(ctx, h, "MacBook", "Mac mini"); err != nil {
		t.Fatal(err)
	}
	if tok, chat := s.h.Bot(); tok != token || chat != "777" {
		t.Fatal("the new holder did not keep the bot")
	}
	st := s.b.Store.Get()
	if st.Offset != 9001 || st.ChatName != "Owner" || st.BotID != 42 {
		t.Fatalf("new holder state = %+v", st)
	}
	eventually(t, "the move said in the chat", func() bool {
		for _, m := range holder.bot.Messages() {
			if strings.Contains(m.Text, "now runs on MacBook, moved from Mac mini") {
				return true
			}
		}
		return false
	})
	if s.b.Routing() {
		t.Fatal("the new holder still routes through the old one")
	}
	if _, err := s.client.Handover(context.Background()); !telegram.NotHolder(err) {
		t.Fatalf("a second handover: %v", err)
	}
}

// A press under a message the holder never posted for that computer, or for
// another computer, is not handed to it.
func TestPressesGoOnlyToTheirComputer(t *testing.T) {
	holder := paired(t, nil)
	s := newSender(t, holder, func(h *host) { h.licensed, h.chatOn = true, true })
	s.ask(t, "p1")
	m := holder.message(1)
	holder.bot.Press(owner, m.MessageID, "h:0")
	eventually(t, "the toast", func() bool { return len(holder.bot.Answers()) > 0 })
	other := link(holder.b, telegram.Sender{ID: "dev-other", Name: "Linux box"})
	if ps, _ := other.Presses(context.Background(), 0); len(ps) != 0 {
		t.Fatalf("another computer got %+v", ps)
	}
	if err := other.Result(context.Background(), telegram.HubResult{ID: "nope", Label: "x"}); err == nil {
		t.Fatal("a result for a message never posted was taken")
	}
	if ps := s.act(t); len(ps) != 1 {
		t.Fatalf("presses = %+v", ps)
	}
}
