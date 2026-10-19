package telegram_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/telegram"
	"github.com/dspv/caprock/internal/telegram/telegramtest"
)

// The token every test uses; no test may find it in a log line or a status.
const token = "123456:SECRET-test-token-do-not-log"

const owner = int64(777)

// host is the daemon, as far as the bridge can tell.
type host struct {
	mu       sync.Mutex
	token    string
	chat     string
	licensed bool
	chatOn   bool
	alertsOn bool
	sessions map[string]telegram.Live
	typed    map[string][]string
	answered []string
	stopped  []string
	started  []string
	mode     string
	projects []telegram.Project
	// order lists the sessions Sessions returns; empty is own, then ext.
	order []string
	// Forwards: what Forward got, the sessions that are busy (their
	// forwards are queued), the chats started, the files saved.
	forwards   []string
	busy       map[string]bool
	nextQueued int64
	chats      []string
	files      map[string][]byte
}

func newHost() *host {
	return &host{token: token, alertsOn: true, sessions: map[string]telegram.Live{
		"own": {ID: "own", Header: "🟠 Claude Code · caprock · Fix the cache test", Title: "Fix the cache test", Owned: true, Alive: true, State: "idle"},
		"ext": {ID: "ext", Header: "🟠 Claude Code · web · Somebody's terminal", Title: "Somebody's terminal", Alive: true, State: "working"},
	}, typed: map[string][]string{}, projects: []telegram.Project{{Name: "caprock", Root: "/home/u/caprock"}, {Name: "web", Root: "/home/u/web"}}}
}

func (h *host) Bot() (string, string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.token, h.chat
}
func (h *host) SaveBot(t string) error  { h.mu.Lock(); h.token = t; h.mu.Unlock(); return nil }
func (h *host) SaveChat(c string) error { h.mu.Lock(); h.chat = c; h.mu.Unlock(); return nil }
func (h *host) Licensed() bool          { h.mu.Lock(); defer h.mu.Unlock(); return h.licensed }
func (h *host) ChatOn() bool            { h.mu.Lock(); defer h.mu.Unlock(); return h.chatOn }
func (h *host) AlertsOn() bool          { h.mu.Lock(); defer h.mu.Unlock(); return h.alertsOn }
func (h *host) Sessions(context.Context) ([]telegram.Live, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.order) > 0 {
		out := make([]telegram.Live, 0, len(h.order))
		for _, id := range h.order {
			out = append(out, h.sessions[id])
		}
		return out, nil
	}
	return []telegram.Live{h.sessions["own"], h.sessions["ext"]}, nil
}
func (h *host) Session(_ context.Context, id string) (telegram.Live, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[id]
	return s, ok
}
func (h *host) Type(id, text string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.sessions[id].Owned {
		return errors.New("not owned")
	}
	h.typed[id] = append(h.typed[id], text)
	return nil
}
func (h *host) Answer(id, prompt string, allow bool) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.answered = append(h.answered, id+"/"+prompt+"/"+map[bool]string{true: "allow", false: "deny"}[allow])
	return nil
}
func (h *host) Stop(id string) error {
	h.mu.Lock()
	h.stopped = append(h.stopped, id)
	h.mu.Unlock()
	return nil
}
func (h *host) Projects(context.Context) ([]telegram.Project, error) {
	return h.projects, nil
}
func (h *host) SpawnMode() string { h.mu.Lock(); defer h.mu.Unlock(); return h.mode }
func (h *host) Start(_ context.Context, dir, prompt, mode string) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.started = append(h.started, dir+"|"+prompt+"|"+mode)
	h.sessions["new"] = telegram.Live{ID: "new", Header: "🟠 Claude Code · caprock · new", Title: "new", Owned: true, Alive: true}
	return "new", nil
}

func (h *host) get(f func(*host) int) int { h.mu.Lock(); defer h.mu.Unlock(); return f(h) }

// stand runs a bridge against a fake Telegram, logging into a buffer.
type stand struct {
	t    *testing.T
	bot  *telegramtest.Bot
	h    *host
	b    *telegram.Bridge
	logs *safeBuf
}

type safeBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *safeBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *safeBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

func newStand(t *testing.T, h *host, opts ...func(*telegram.Bridge)) *stand {
	t.Helper()
	bot := telegramtest.New(token, "caprock_test_bot")
	t.Cleanup(bot.Close)
	logs := &safeBuf{}
	b := telegram.New(h, t.TempDir(), slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	b.Base = bot.URL()
	b.PollWait = time.Second
	b.Out.Gap = 10 * time.Millisecond
	for _, o := range opts {
		o(b)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go b.Run(ctx)
	s := &stand{t: t, bot: bot, h: h, b: b, logs: logs}
	t.Cleanup(func() {
		if strings.Contains(logs.String(), token) {
			t.Errorf("the token reached the log:\n%s", logs.String())
		}
		if strings.Contains(b.Status().LastError, token) {
			t.Errorf("the token reached the status: %q", b.Status().LastError)
		}
	})
	return s
}

// paired is a stand whose chat is already paired.
func paired(t *testing.T, mut func(*host)) *stand {
	h := newHost()
	h.chat = "777"
	if mut != nil {
		mut(h)
	}
	return newStand(t, h)
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// lastMessage waits for the nth message (1-based) and returns it.
func (s *stand) message(n int) telegramtest.Sent {
	s.t.Helper()
	eventually(s.t, "message "+string(rune('0'+n)), func() bool { return len(s.bot.Messages()) >= n })
	return s.bot.Messages()[n-1]
}

// deliver sends an alert about a session and returns its message id.
func (s *stand) deliver(session, prompt string, buttons ...string) int64 {
	s.t.Helper()
	var mk *telegram.Markup
	if len(buttons) > 0 {
		row := []telegram.InlineButton{}
		for _, b := range buttons {
			row = append(row, telegram.InlineButton{Text: b, CallbackData: b})
		}
		mk = &telegram.Markup{InlineKeyboard: [][]telegram.InlineButton{row}}
	}
	done := make(chan error, 1)
	s.b.Deliver(telegram.Out{Text: "an alert about " + session, Markup: mk}, telegram.Ref{SessionID: session, PromptID: prompt, Kind: "alert"}, func(err error) { done <- err })
	if err := <-done; err != nil {
		s.t.Fatal(err)
	}
	msgs := s.bot.Messages()
	return msgs[len(msgs)-1].MessageID
}

// The first private chat to send the code is paired; a wrong code, a group
// and a stranger after it get nothing in.
func TestPairingTakesTheFirstPrivateChatWithTheCode(t *testing.T) {
	h := newHost()
	s := newStand(t, h)
	p, err := s.b.StartPairing()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(p.Link, "t.me/caprock_test_bot?start="+p.Code) {
		// The username comes from getMe at Connect; without it, no link.
		if p.Link != "" {
			t.Fatalf("link = %q", p.Link)
		}
	}
	wrong := "000000"
	if p.Code == wrong {
		wrong = "111111"
	}
	s.bot.Say(500, "Stranger", "/start "+wrong)
	eventually(t, "the wrong-code answer", func() bool { return len(s.bot.Messages()) >= 1 })
	if m := s.bot.Messages()[0]; m.ChatID != "500" || !strings.Contains(m.Text, "does not match") {
		t.Fatalf("wrong code answered with %+v", m)
	}
	s.bot.SayIn(-900, "group", "Team", "/start "+p.Code, 0)
	eventually(t, "the group refusal", func() bool { return len(s.bot.Messages()) >= 2 })
	if c, _ := h.Bot(); c == "" {
		_ = c
	}
	if _, chat := h.Bot(); chat != "" {
		t.Fatalf("a group was paired: %q", chat)
	}
	s.bot.Say(owner, "Owner", "/start "+p.Code)
	eventually(t, "pairing", func() bool { _, c := h.Bot(); return c == "777" })
	m := s.message(3)
	if m.ChatID != "777" || !strings.Contains(m.Text, "Paired") {
		t.Fatalf("welcome = %+v", m)
	}
	if st := s.b.Status(); st.ChatName != "Owner" || st.Pairing != nil || st.ManualChat {
		t.Fatalf("status after pairing = %+v", st)
	}
	eventually(t, "the command menu", func() bool { return contains(s.bot.Calls(), "setMyCommands") })

	// The code is spent: the same code from another chat pairs nothing.
	s.bot.Say(501, "Late", "/start "+p.Code)
	s.bot.Say(owner, "Owner", "/help")
	eventually(t, "the help", func() bool { return len(s.bot.Messages()) >= 4 })
	time.Sleep(100 * time.Millisecond)
	if _, chat := h.Bot(); chat != "777" {
		t.Fatalf("chat = %q after a late code", chat)
	}
	for _, m := range s.bot.Messages() {
		if m.ChatID == "501" {
			t.Fatalf("a stranger was answered: %+v", m)
		}
	}
}

// Connect checks the token with getMe and refuses one Telegram does not
// know, without saving it.
func TestConnectChecksTheToken(t *testing.T) {
	h := newHost()
	h.token = ""
	s := newStand(t, h)
	if _, err := s.b.Connect(context.Background(), "999:wrong"); err == nil || !strings.Contains(err.Error(), "does not recognise") {
		t.Fatalf("a wrong token: %v", err)
	}
	if tok, _ := h.Bot(); tok != "" {
		t.Fatal("a refused token was saved")
	}
	u, err := s.b.Connect(context.Background(), token)
	if err != nil || u.Username != "caprock_test_bot" {
		t.Fatalf("connect = %+v, %v", u, err)
	}
	st := s.b.Status()
	if !st.BotSet || st.BotUsername != "caprock_test_bot" || strings.Contains(st.TokenMasked, "SECRET") || !strings.HasSuffix(st.TokenMasked, "-log") {
		t.Fatalf("status = %+v", st)
	}
	p, _ := s.b.StartPairing()
	if p.Link != "https://t.me/caprock_test_bot?start="+p.Code {
		t.Fatalf("link = %q", p.Link)
	}
}

// A message from any chat but the paired one gets no answer and does
// nothing.
func TestAnotherChatIsIgnored(t *testing.T) {
	s := paired(t, func(h *host) { h.licensed, h.chatOn = true, true })
	id := s.deliver("own", "")
	s.bot.Reply(555, id, "rm -rf ~")
	s.bot.Say(555, "Stranger", "/sessions")
	s.bot.Press(555, id, "m")
	time.Sleep(300 * time.Millisecond)
	if n := len(s.bot.Messages()); n != 1 {
		t.Fatalf("%d messages; a stranger was answered: %+v", n, s.bot.Messages())
	}
	if len(s.h.typed) != 0 || s.b.Muted("own") {
		t.Fatal("a stranger's message did something")
	}
}

// A reply goes to the session its message is about, and is acknowledged
// with a reaction, not another message.
func TestAReplyIsTypedIntoItsSession(t *testing.T) {
	s := paired(t, func(h *host) { h.licensed, h.chatOn = true, true })
	id := s.deliver("own", "")
	s.bot.Reply(owner, id, "run the tests again")
	eventually(t, "typing", func() bool { return s.h.get(func(h *host) int { return len(h.typed["own"]) }) == 1 })
	if got := s.h.typed["own"][0]; got != "run the tests again" {
		t.Fatalf("typed %q", got)
	}
	eventually(t, "the reaction", func() bool {
		for _, m := range s.bot.Sent() {
			if m.Method == "setMessageReaction" && m.Emoji == "👍" {
				return true
			}
		}
		return false
	})
	if !s.b.Conversing("own") {
		t.Fatal("a session typed into from Telegram is not marked as conversing")
	}
}

// Rule 7: a session Caprock did not start is watched, never typed into.
func TestAReplyToASessionCaprockDidNotStartIsRefused(t *testing.T) {
	s := paired(t, func(h *host) { h.licensed, h.chatOn = true, true })
	id := s.deliver("ext", "")
	s.bot.Reply(owner, id, "hello")
	m := s.message(2)
	if !strings.Contains(m.Text, "I can only watch this one") || m.ReplyTo == 0 {
		t.Fatalf("answer = %+v", m)
	}
	if len(s.h.typed) != 0 {
		t.Fatal("typed into a session Caprock did not start")
	}
	// /stop is refused the same way.
	s.bot.Say(owner, "Owner", "/sessions")
	s.message(3)
	s.bot.Say(owner, "Owner", "/stop 2")
	if m := s.message(4); !strings.Contains(m.Text, "only stop sessions Caprock started") {
		t.Fatalf("/stop of a watched session: %+v", m)
	}
}

// Without a licence a reply types nothing, and the chat hears why once.
// Mute needs no licence.
func TestTalkingBackIsPremium(t *testing.T) {
	s := paired(t, nil)
	id := s.deliver("own", "p1", "y", "n", "m")
	s.bot.Reply(owner, id, "go on")
	m := s.message(2)
	if !strings.Contains(m.Text, "Premium") || !strings.Contains(m.Text, telegram.PremiumURL) {
		t.Fatalf("premium line = %q", m.Text)
	}
	for _, bad := range []string{"coming soon", "not built", "pilot"} {
		if strings.Contains(strings.ToLower(m.Text), bad) {
			t.Fatalf("the premium line says %q", bad)
		}
	}
	s.bot.Reply(owner, id, "and again")
	s.bot.Say(owner, "Owner", "/sessions")
	s.bot.Press(owner, id, "y")
	eventually(t, "the button's toast", func() bool { return len(s.bot.Answers()) >= 1 })
	if a := s.bot.Answers()[0]; !strings.Contains(a, "Premium") {
		t.Fatalf("toast = %q", a)
	}
	time.Sleep(200 * time.Millisecond)
	if n := len(s.bot.Messages()); n != 2 {
		t.Fatalf("%d messages: the premium line was repeated: %+v", n, s.bot.Messages())
	}
	if len(s.h.typed) != 0 || len(s.h.answered) != 0 {
		t.Fatal("an unlicensed reply or button did something")
	}
	// Free: mute.
	s.bot.Press(owner, id, "m")
	eventually(t, "mute", func() bool { return s.b.Muted("own") })

	// Licensed but switched off: says where the switch is.
	s.h.mu.Lock()
	s.h.licensed = true
	s.h.mu.Unlock()
	_ = s.b.Store.Update(func(st *telegram.State) { st.PremiumNoteAt = 0 })
	s.bot.Reply(owner, id, "now?")
	if m := s.message(3); !strings.Contains(m.Text, "Two-way chat is off") {
		t.Fatalf("switched off: %q", m.Text)
	}
}

// Approve answers the prompt the message was about, through the host's
// answer path, and the buttons say it was answered.
func TestApproveAnswersItsPrompt(t *testing.T) {
	s := paired(t, func(h *host) { h.licensed, h.chatOn = true, true })
	id := s.deliver("own", "prompt-1", "y", "n", "m")
	s.bot.Press(owner, id, "y")
	eventually(t, "the answer", func() bool { return s.h.get(func(h *host) int { return len(h.answered) }) == 1 })
	if got := s.h.answered[0]; got != "own/prompt-1/allow" {
		t.Fatalf("answered %q", got)
	}
	eventually(t, "the edit", func() bool {
		for _, m := range s.bot.Sent() {
			if m.Method == "editMessageReplyMarkup" && m.ReplyTo == id && len(m.Buttons) == 1 && m.Buttons[0] == "-" {
				return true
			}
		}
		return false
	})
}

// /new starts Claude Code in the named project; in Bypass it asks first.
func TestNewAsksBeforeBypass(t *testing.T) {
	s := paired(t, func(h *host) { h.licensed, h.chatOn, h.mode = true, true, "bypassPermissions" })
	s.bot.Say(owner, "Owner", "/new capr fix the flaky test")
	m := s.message(1)
	if !strings.Contains(m.Text, "Bypass") || len(m.Buttons) != 3 {
		t.Fatalf("confirmation = %+v", m)
	}
	if len(s.h.started) != 0 {
		t.Fatal("started before the confirmation")
	}
	s.bot.Press(owner, m.MessageID, "b")
	eventually(t, "the start", func() bool { return s.h.get(func(h *host) int { return len(h.started) }) == 1 })
	if got := s.h.started[0]; got != "/home/u/caprock|fix the flaky test|bypassPermissions" {
		t.Fatalf("started %q", got)
	}
	if m := s.message(2); !strings.Contains(m.Text, "Started") {
		t.Fatalf("after start: %+v", m)
	}
	if !s.b.Conversing("new") {
		t.Fatal("a session started from Telegram does not answer there")
	}
	// An unknown project names the ones there are.
	s.bot.Say(owner, "Owner", "/new nope do it")
	if m := s.message(3); !strings.Contains(m.Text, "caprock, web") {
		t.Fatalf("unknown project: %q", m.Text)
	}
}

// /stop asks, and stops only on the button.
func TestStopAsksFirst(t *testing.T) {
	s := paired(t, func(h *host) { h.licensed, h.chatOn = true, true })
	s.bot.Say(owner, "Owner", "/sessions")
	list := s.message(1)
	if !strings.Contains(list.Text, "1.</b> 🟠 Claude Code · caprock") || !strings.Contains(list.Text, "watch only") {
		t.Fatalf("list = %q", list.Text)
	}
	if len(list.Buttons) != 1 || list.Buttons[0] != "t:1" {
		t.Fatalf("only the owned session gets a button: %v", list.Buttons)
	}
	s.bot.Say(owner, "Owner", "/stop 1")
	q := s.message(2)
	if len(s.h.stopped) != 0 {
		t.Fatal("stopped without asking")
	}
	s.bot.Press(owner, q.MessageID, "k")
	eventually(t, "the stop", func() bool { return s.h.get(func(h *host) int { return len(h.stopped) }) == 1 })
	// Tapping a number asks for a reply to that session.
	s.bot.Press(owner, list.MessageID, "t:1")
	m := s.message(3)
	if !m.ForceReply || !strings.Contains(m.Text, "Fix the cache test") {
		t.Fatalf("talk prompt = %+v", m)
	}
	s.bot.Reply(owner, m.MessageID, "carry on")
	eventually(t, "typing", func() bool { return s.h.get(func(h *host) int { return len(h.typed["own"]) }) == 1 })
}

// A message sent while nobody was reading is not typed into anything.
func TestAStaleMessageIsSkipped(t *testing.T) {
	s := paired(t, func(h *host) { h.licensed, h.chatOn = true, true })
	id := s.deliver("own", "")
	s.bot.SayOld(owner, "/sessions", 10*time.Minute)
	s.bot.Say(owner, "Owner", "/help")
	m := s.message(2)
	if !strings.Contains(m.Text, "Talking to your agents") {
		t.Fatalf("expected the help next, got %+v", m)
	}
	_ = id
}

// Mute by command, by number and for everything.
func TestMuteCommands(t *testing.T) {
	s := paired(t, nil)
	id := s.deliver("own", "")
	s.bot.Reply(owner, id, "/mute")
	eventually(t, "mute by reply", func() bool { return s.b.Muted("own") })
	if s.b.Muted("ext") {
		t.Fatal("muting one muted another")
	}
	s.bot.Say(owner, "Owner", "/mute all")
	eventually(t, "mute all", func() bool { return s.b.Muted("ext") })
	s.bot.Say(owner, "Owner", "/unmute")
	eventually(t, "unmute", func() bool { return !s.b.Muted("own") && !s.b.Muted("ext") })
}

// A transport failure carries the request URL, which carries the token; the
// status and the log get the cause without it. (The stand's cleanup checks
// both.)
func TestTheTokenNeverReachesTheLog(t *testing.T) {
	s := paired(t, nil)
	s.bot.Close() // every call now fails at the transport
	done := make(chan error, 1)
	s.b.Deliver(telegram.Out{Text: "x"}, telegram.Ref{SessionID: "own"}, func(err error) { done <- err })
	err := <-done
	if err == nil || strings.Contains(err.Error(), token) {
		t.Fatalf("send error = %v", err)
	}
	eventually(t, "a poll error", func() bool { return s.b.Status().LastError != "" })
	if _, err := s.b.Connect(context.Background(), token); err == nil || strings.Contains(err.Error(), token) {
		t.Fatalf("connect error = %v", err)
	}
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

// SendPhoto needs a bot and a chat, cuts a long caption to Telegram's limit,
// and never puts the token in its error.
func TestSendPhotoNeedsAPairedChat(t *testing.T) {
	const ptoken = "9:SECRET-bridge-photo"
	bot := telegramtest.New(ptoken, "b")
	defer bot.Close()
	h := &photoHost{}
	b := telegram.New(h, t.TempDir(), nil)
	b.Base = bot.URL()
	if err := b.SendPhoto(context.Background(), []byte("x"), "c"); !errors.Is(err, telegram.ErrNotPaired) {
		t.Fatalf("no bot: %v", err)
	}
	h.token, h.chat = ptoken, "5"
	long := strings.Repeat("é", telegram.MaxCaption+50)
	if err := b.SendPhoto(context.Background(), []byte("png"), long); err != nil {
		t.Fatal(err)
	}
	s := bot.Sent()
	if len(s) != 1 || s[0].Method != "sendPhoto" || len([]rune(s[0].Text)) != telegram.MaxCaption || string(s[0].Photo) != "png" {
		t.Fatalf("sent = %+v", s)
	}
	h.token = "9:SECRET-wrong"
	if err := b.SendPhoto(context.Background(), []byte("png"), ""); err == nil || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("a refused token: %v", err)
	}
}

type photoHost struct{ token, chat string }

func (h *photoHost) Bot() (string, string)                             { return h.token, h.chat }
func (h *photoHost) SaveBot(string) error                              { return nil }
func (h *photoHost) SaveChat(string) error                             { return nil }
func (h *photoHost) Licensed() bool                                    { return false }
func (h *photoHost) ChatOn() bool                                      { return false }
func (h *photoHost) AlertsOn() bool                                    { return false }
func (h *photoHost) Sessions(context.Context) ([]telegram.Live, error) { return nil, nil }
func (h *photoHost) Session(context.Context, string) (telegram.Live, bool) {
	return telegram.Live{}, false
}
func (h *photoHost) Type(string, string) error                            { return nil }
func (h *photoHost) Answer(string, string, bool) error                    { return nil }
func (h *photoHost) Stop(string) error                                    { return nil }
func (h *photoHost) Projects(context.Context) ([]telegram.Project, error) { return nil, nil }
func (h *photoHost) SpawnMode() string                                    { return "" }
func (h *photoHost) Start(context.Context, string, string, string) (string, error) {
	return "", nil
}
func (h *photoHost) Forward(context.Context, string, string) (int64, error) { return 0, nil }
func (h *photoHost) StartChat(context.Context, string, string) (string, error) {
	return "", nil
}
func (h *photoHost) SaveFile(string, string, []byte) (string, error) { return "", nil }
