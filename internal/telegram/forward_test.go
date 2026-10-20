package telegram_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/telegram"
	"github.com/dspv/caprock/internal/telegram/telegramtest"
)

func (h *host) Forward(_ context.Context, id, text string) (int64, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.sessions[id].Owned {
		return 0, errors.New("not owned")
	}
	h.forwards = append(h.forwards, id+"|"+text)
	if h.busy[id] {
		h.nextQueued++
		return h.nextQueued, nil
	}
	return 0, nil
}

func (h *host) StartChat(_ context.Context, text, mode string) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.chats = append(h.chats, mode+"|"+text)
	return "chat-1", nil
}

func (h *host) SaveFile(name, _ string, data []byte) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if strings.HasSuffix(name, ".exe") {
		return "", errors.New(".exe is not a type Caprock keeps")
	}
	if h.files == nil {
		h.files = map[string][]byte{}
	}
	path := "/data/paste/1/" + name
	h.files[path] = data
	return path, nil
}

func (h *host) forwarded() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.forwards...)
}

// talking is a paired stand where two-way chat is on and bursts close fast.
func talking(t *testing.T, mut func(*host)) *stand {
	h := newHost()
	h.chat = "777"
	h.licensed, h.chatOn = true, true
	if mut != nil {
		mut(h)
	}
	return newStand(t, h, func(b *telegram.Bridge) { b.BurstWait = 150 * time.Millisecond })
}

func fwdFrom(name, text string) telegram.Message {
	return telegram.Message{Text: text, ForwardOrigin: &telegram.ForwardOrigin{Type: "user", SenderUser: &telegram.User{FirstName: name}}}
}

// picker waits for the "Where to?" message and returns it.
func (s *stand) picker() telegramtest.Sent {
	s.t.Helper()
	var p telegramtest.Sent
	eventually(s.t, "the picker", func() bool {
		for _, m := range s.bot.Messages() {
			if strings.Contains(m.Text, "Where to?") {
				p = m
				return true
			}
		}
		return false
	})
	return p
}

// edited waits for an edit of msg whose text contains want.
func (s *stand) edited(msg int64, want string) {
	s.t.Helper()
	eventually(s.t, "an edit saying "+want, func() bool {
		for _, m := range s.bot.Sent() {
			if m.Method == "editMessageText" && m.ReplyTo == msg && strings.Contains(m.Text, want) {
				return true
			}
		}
		return false
	})
}

func countPickers(bot *telegramtest.Bot) int {
	n := 0
	for _, m := range bot.Messages() {
		if strings.Contains(m.Text, "Where to?") {
			n++
		}
	}
	return n
}

// Three forwards and a photo sent together, with a comment typed first, are
// asked about once and go to the agent as one message: the words first,
// then each item quoted with where it came from, the photo as its saved path.
func TestForwardBurstGoesAsOneMessage(t *testing.T) {
	s := talking(t, nil)
	s.bot.AddFile("ph-big", "photos/file_1.jpg", []byte("JPEG"))
	s.bot.Say(owner, "Owner", "look at these")
	s.bot.Send(owner, fwdFrom("Alice", "the build is red\nsince noon"))
	s.bot.Send(owner, telegram.Message{Text: "see https://example.com/x", ForwardOrigin: &telegram.ForwardOrigin{Type: "hidden_user"}})
	s.bot.Send(owner, telegram.Message{Caption: "screenshot", MediaGroupID: "g1", ForwardOrigin: &telegram.ForwardOrigin{Type: "channel", Chat: &telegram.Chat{Title: "CI news"}},
		Photo: []telegram.PhotoSize{{FileID: "ph-small"}, {FileID: "ph-big", FileSize: 4}}})

	p := s.picker()
	if !strings.Contains(p.Text, "(2 messages, 1 photo)") || !strings.Contains(p.Text, "look at these") {
		t.Fatalf("picker text = %q", p.Text)
	}
	if strings.Join(p.Buttons, ",") != "f:1,f:n,f:x,f:r" {
		t.Fatalf("buttons = %v (only the owned session is offered)", p.Buttons)
	}
	time.Sleep(300 * time.Millisecond)
	if n := countPickers(s.bot); n != 1 {
		t.Fatalf("%d pickers for one burst", n)
	}

	s.bot.Press(owner, p.MessageID, "f:1")
	s.edited(p.MessageID, "✓ Sent to")
	got := s.h.forwarded()
	if len(got) != 1 {
		t.Fatalf("forwards = %q", got)
	}
	want := "own|look at these\n\n" +
		"> Forwarded from Alice\n> the build is red\n> since noon\n\n" +
		"> Forwarded message\n> see https://example.com/x\n\n" +
		"> Forwarded from CI news\n> screenshot\n> Photo: \"/data/paste/1/photo.jpg\""
	if got[0] != want {
		t.Fatalf("message =\n%s\nwant\n%s", got[0], want)
	}
	s.h.mu.Lock()
	saved := string(s.h.files["/data/paste/1/photo.jpg"])
	s.h.mu.Unlock()
	if saved != "JPEG" {
		t.Fatalf("the largest photo size was not fetched: %q", saved)
	}
}

// Sessions are offered as the phone's Continue lists them: waiting, then
// working, then recent; never one Caprock did not start, a chat, an ended
// one, or one quiet for more than two days.
func TestForwardPickerOrdersSessions(t *testing.T) {
	now := time.Now()
	s := talking(t, func(h *host) {
		h.sessions = map[string]telegram.Live{
			"idle":    {ID: "idle", Title: "Idle one", Owned: true, Alive: true, LastAt: now.Add(-2 * time.Hour)},
			"old":     {ID: "old", Title: "Old one", Owned: true, Alive: true, LastAt: now.Add(-72 * time.Hour)},
			"work":    {ID: "work", Title: "Working one", Owned: true, Alive: true, Working: true, LastAt: now},
			"wait":    {ID: "wait", Title: "Waiting one", Owned: true, Alive: true, Waiting: true, LastAt: now.Add(-time.Hour)},
			"ext":     {ID: "ext", Title: "Terminal", Alive: true, Working: true, LastAt: now},
			"chat":    {ID: "chat", Title: "A chat", Owned: true, Alive: true, Chat: true, LastAt: now},
			"ended":   {ID: "ended", Title: "Ended", Owned: true, LastAt: now},
			"recent2": {ID: "recent2", Title: "Idle two", Owned: true, Alive: true, LastAt: now.Add(-10 * time.Minute)},
		}
		h.order = []string{"idle", "old", "work", "wait", "ext", "chat", "ended", "recent2"}
	})
	s.bot.Send(owner, fwdFrom("Bob", "hi"))
	p := s.picker()
	if strings.Join(p.Buttons, ",") != "f:1,f:2,f:3,f:4,f:n,f:x,f:r" {
		t.Fatalf("buttons = %v", p.Buttons)
	}
	s.bot.Press(owner, p.MessageID, "f:3")
	s.edited(p.MessageID, "Idle two")
	// The picker's edit can land before the forward does (CI, 2026-10-20).
	eventually(t, "button 3 sent to the newest idle session", func() bool {
		got := s.h.forwarded()
		return len(got) == 1 && strings.HasPrefix(got[0], "recent2|")
	})
	if got := s.h.forwarded(); len(got) != 1 || !strings.HasPrefix(got[0], "recent2|") {
		t.Fatalf("button 3 sent to %q; want the newest idle session after waiting and working", got)
	}
}

// A forward to a working session waits in the queue; the picker says so,
// then says it went once the queue typed it in. With Reply here on, that
// turn's answer is asked for.
func TestForwardToBusySessionIsQueuedThenSent(t *testing.T) {
	s := talking(t, func(h *host) { h.busy = map[string]bool{"own": true} })
	s.bot.Send(owner, fwdFrom("Alice", "please look"))
	p := s.picker()
	s.bot.Press(owner, p.MessageID, "f:r")
	eventually(t, "the switch turned on", func() bool {
		for _, m := range s.bot.Sent() {
			if m.Method == "editMessageReplyMarkup" && m.ReplyTo == p.MessageID {
				return true
			}
		}
		return false
	})
	if !s.b.Store.Get().ForwardReply {
		t.Fatal("Reply here was not remembered")
	}
	s.bot.Press(owner, p.MessageID, "f:1")
	s.edited(p.MessageID, "is busy — will send when it finishes")
	if s.b.TakeReplyOnce("own") {
		t.Fatal("the answer was asked for before the message went in")
	}
	s.b.QueuedSent(1)
	s.edited(p.MessageID, "✓ Sent to")
	if !s.b.TakeReplyOnce("own") {
		t.Fatal("Reply here on, but the answer was not asked for")
	}
	if s.b.TakeReplyOnce("own") {
		t.Fatal("the answer is asked for once")
	}
}

// Reply here is off by default: nothing is asked back.
func TestForwardReplyOffByDefault(t *testing.T) {
	s := talking(t, nil)
	s.bot.Send(owner, fwdFrom("Alice", "x"))
	p := s.picker()
	if !strings.Contains(strings.Join(p.Buttons, ","), "f:r") {
		t.Fatalf("no Reply here switch: %v", p.Buttons)
	}
	s.bot.Press(owner, p.MessageID, "f:1")
	s.edited(p.MessageID, "✓ Sent to")
	if s.b.TakeReplyOnce("own") {
		t.Fatal("an answer was asked for with Reply here off")
	}
}

// + New chat starts a chat with the forward as its first message; in Bypass
// it asks first.
func TestForwardNewChat(t *testing.T) {
	s := talking(t, func(h *host) { h.mode = "bypassPermissions" })
	s.bot.Send(owner, fwdFrom("Alice", "an idea"))
	p := s.picker()
	s.bot.Press(owner, p.MessageID, "f:n")
	eventually(t, "the Bypass question", func() bool {
		for _, m := range s.bot.Sent() {
			if m.Method == "editMessageReplyMarkup" && m.ReplyTo == p.MessageID && contains(m.Buttons, "f:nd") {
				return true
			}
		}
		return false
	})
	s.bot.Press(owner, p.MessageID, "f:nd")
	s.edited(p.MessageID, "Started a new chat")
	s.h.mu.Lock()
	chats := append([]string(nil), s.h.chats...)
	s.h.mu.Unlock()
	if len(chats) != 1 || chats[0] != "default|> Forwarded from Alice\n> an idea" {
		t.Fatalf("chats = %q", chats)
	}
}

// Cancel sends nothing, and a second tap finds the question gone.
func TestForwardCancel(t *testing.T) {
	s := talking(t, nil)
	s.bot.Send(owner, fwdFrom("Alice", "nope"))
	p := s.picker()
	s.bot.Press(owner, p.MessageID, "f:x")
	s.edited(p.MessageID, "Cancelled")
	s.bot.Press(owner, p.MessageID, "f:1")
	eventually(t, "the expired toast", func() bool {
		return contains(s.bot.Answers(), "That question has expired. Forward the messages again.")
	})
	if got := s.h.forwarded(); len(got) != 0 {
		t.Fatalf("a cancelled forward was sent: %q", got)
	}
}

// A voice note is saved as a file and named as not transcribed; a file of a
// type Caprock does not keep is named as not saved.
func TestForwardVoiceAndRefusedFile(t *testing.T) {
	s := talking(t, nil)
	s.bot.AddFile("v1", "voice/file_2.oga", []byte("OGG"))
	s.bot.AddFile("d1", "docs/file_3.exe", []byte("MZ"))
	s.bot.Send(owner, telegram.Message{Voice: &telegram.FileRef{FileID: "v1", MimeType: "audio/ogg", FileSize: 3}})
	s.bot.Send(owner, telegram.Message{Document: &telegram.FileRef{FileID: "d1", FileName: "tool.exe", FileSize: 2}})
	p := s.picker()
	if !strings.Contains(p.Text, "1 voice message") || !strings.Contains(p.Text, "1 file") {
		t.Fatalf("picker = %q", p.Text)
	}
	s.bot.Press(owner, p.MessageID, "f:1")
	s.edited(p.MessageID, "✓ Sent to")
	got := s.h.forwarded()
	if len(got) != 1 || !strings.Contains(got[0], `> Voice message (not transcribed): "/data/paste/1/voice.ogg"`) ||
		!strings.Contains(got[0], "> File tool.exe (not saved: .exe is not a type Caprock keeps)") {
		t.Fatalf("message = %q", got)
	}
}

// A forward from any chat but the paired one is not asked about.
func TestForwardFromAnotherChatIsIgnored(t *testing.T) {
	s := talking(t, nil)
	s.bot.Send(500, fwdFrom("Alice", "let me in"))
	s.bot.Say(owner, "Owner", "/help")
	eventually(t, "the help", func() bool { return len(s.bot.Messages()) >= 1 })
	time.Sleep(400 * time.Millisecond)
	for _, m := range s.bot.Messages() {
		if m.ChatID == "500" || strings.Contains(m.Text, "Where to?") {
			t.Fatalf("a stranger's forward was answered: %+v", m)
		}
	}
}

// Without Premium the picker does not appear; the once-a-day line does.
func TestForwardNeedsPremium(t *testing.T) {
	s := paired(t, nil)
	s.bot.Send(owner, fwdFrom("Alice", "x"))
	m := s.message(1)
	if !strings.Contains(m.Text, "Premium") {
		t.Fatalf("got %q", m.Text)
	}
	if countPickers(s.bot) != 0 {
		t.Fatal("a picker without a licence")
	}
}

// A plain message with no forward after it is still answered as one.
func TestPlainMessageStillGetsTheHint(t *testing.T) {
	s := talking(t, nil)
	s.bot.Say(owner, "Owner", "hello")
	m := s.message(1)
	if !strings.Contains(m.Text, "Reply to one of my messages") {
		t.Fatalf("got %q", m.Text)
	}
}
