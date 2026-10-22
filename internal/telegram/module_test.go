package telegram_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/dspv/caprock/internal/telegram"
	"github.com/dspv/caprock/internal/telegram/telegramtest"
)

// kept is a module store as the bridge sees it: what ModuleAnswer wrote.
type kept struct {
	mu   sync.Mutex
	docs map[string]map[string]any // "<module>/<doc>" → data
}

func (k *kept) answer(_ context.Context, module, doc string, data map[string]any) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if module == "gone" {
		return errors.New("no admin key names this module")
	}
	k.docs[module+"/"+doc] = data
	return nil
}

func (k *kept) get(key string) (map[string]any, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	d, ok := k.docs[key]
	return d, ok
}

// moduleStand is a paired bot with no alert and no two-way chat on: only a
// module message can make it read updates.
func moduleStand(t *testing.T) (*stand, *kept) {
	k := &kept{docs: map[string]map[string]any{}}
	h := newHost()
	h.chat = "777"
	h.alertsOn = false
	return newStand(t, h, func(b *telegram.Bridge) { b.ModuleAnswer = k.answer }), k
}

// A module's message names the module on its first line, carries its
// buttons, and a press is written into the module's store, the message
// then showing the choice. Nothing of it needs Premium or an alert switch.
func TestAModuleButtonIsWrittenToItsStore(t *testing.T) {
	s, k := moduleStand(t)
	id, err := s.b.SendModule(context.Background(), telegram.ModuleMessage{
		Module: "ops", Name: "Ops <desk>", Text: "Deploy web to prod?",
		Buttons: []telegram.ModuleButton{{ID: "yes", Label: "Deploy"}, {ID: "no", Label: "Not now"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	m := s.message(1)
	if m.MessageID != id || m.Text != "🧩 <b>Ops &lt;desk&gt;</b>\nDeploy web to prod?" || m.ParseMode != "HTML" {
		t.Fatalf("sent %+v (id %d)", m, id)
	}
	if strings.Join(m.Buttons, ",") != "x:yes,x:no" {
		t.Fatalf("buttons %v", m.Buttons)
	}
	s.bot.Press(owner, id, "x:yes")
	key := "ops/" + strconv.FormatInt(id, 10) + "-1"
	eventually(t, "the answer in the store", func() bool { _, ok := k.get(key); return ok })
	if d, _ := k.get(key); d["button"] != "yes" || d["at"] == nil {
		t.Fatalf("doc %v", d)
	}
	eventually(t, "the edit", func() bool {
		for _, e := range s.bot.Sent() {
			if e.Method == "editMessageReplyMarkup" && e.ReplyTo == id {
				return true
			}
		}
		return false
	})
	if a := s.bot.Answers(); len(a) == 0 || a[len(a)-1] != "" {
		t.Fatalf("callback answers %q", a)
	}
}

// A text reply to a module's message is the module's, never a session's.
func TestAReplyToAModuleMessageIsTheModules(t *testing.T) {
	s, k := moduleStand(t)
	id, err := s.b.SendModule(context.Background(), telegram.ModuleMessage{Module: "ops", Name: "Ops", Text: "Why did it fail?", Reply: true})
	if err != nil {
		t.Fatal(err)
	}
	if m := s.message(1); !m.ForceReply {
		t.Fatalf("no reply field: %+v", m)
	}
	s.bot.Reply(owner, id, "the disk was full")
	s.bot.Reply(owner, id, "cleaned it")
	key := "ops/" + strconv.FormatInt(id, 10)
	eventually(t, "both answers", func() bool { _, ok := k.get(key + "-2"); return ok })
	if d, _ := k.get(key + "-1"); d["text"] != "the disk was full" {
		t.Fatalf("first doc %v", d)
	}
	if got := s.h.get(func(h *host) int { return len(h.typed) }); got != 0 {
		t.Fatalf("a module reply was typed into a session")
	}
}

// No chat is a refusal, /mute all is respected, and a bad message is
// refused before anything leaves.
func TestAModuleMessageNeedsAPairedUnmutedChat(t *testing.T) {
	h := newHost()
	s := newStand(t, h)
	if _, err := s.b.SendModule(context.Background(), telegram.ModuleMessage{Module: "ops", Text: "hi"}); !errors.Is(err, telegram.ErrNotPaired) {
		t.Fatalf("no chat: %v", err)
	}
	h.mu.Lock()
	h.chat = "777"
	h.mu.Unlock()
	for _, bad := range []telegram.ModuleMessage{
		{Module: "ops", Text: "  "},
		{Module: "ops", Text: "hi", Buttons: []telegram.ModuleButton{{ID: "a b", Label: "x"}}},
		{Module: "ops", Text: "hi", Buttons: []telegram.ModuleButton{{ID: "a", Label: ""}}},
		{Module: "ops", Text: "hi", Buttons: []telegram.ModuleButton{{ID: "a", Label: "x"}, {ID: "a", Label: "y"}}},
	} {
		if _, err := s.b.SendModule(context.Background(), bad); !errors.Is(err, telegram.ErrModuleMessage) {
			t.Fatalf("%+v: %v", bad, err)
		}
	}
	_ = s.b.Store.Update(func(st *telegram.State) { st.MuteAll = true })
	if _, err := s.b.SendModule(context.Background(), telegram.ModuleMessage{Module: "ops", Text: "hi"}); !errors.Is(err, telegram.ErrMuted) {
		t.Fatalf("muted: %v", err)
	}
	if n := len(s.bot.Messages()); n != 0 {
		t.Fatalf("%d messages sent", n)
	}
}

// A press for a module the key no longer names is not kept, and says so.
func TestAPressForAGoneModuleSaysSo(t *testing.T) {
	s, _ := moduleStand(t)
	id, err := s.b.SendModule(context.Background(), telegram.ModuleMessage{Module: "gone", Text: "?", Buttons: []telegram.ModuleButton{{ID: "ok", Label: "OK"}}})
	if err != nil {
		t.Fatal(err)
	}
	s.bot.Press(owner, id, "x:ok")
	eventually(t, "the refusal", func() bool {
		a := s.bot.Answers()
		return len(a) > 0 && strings.HasPrefix(a[len(a)-1], "Not saved:")
	})
}

// lastEdit is the latest edit the fake received for message id, and how
// many there were.
func lastEdit(s *stand, id int64) (telegramtest.Sent, int) {
	var last telegramtest.Sent
	n := 0
	for _, e := range s.bot.Sent() {
		if (e.Method == "editMessageText" || e.Method == "editMessageReplyMarkup") && e.ReplyTo == id {
			last = e
			n++
		}
	}
	return last, n
}

func ptr[T any](v T) *T { return &v }

// A module edits its own message: new text keeps the buttons it shows, new
// buttons alone are a markup edit, an empty list removes them, and a press
// on edited buttons lands in the store like a press on the first ones.
func TestAModuleEditsItsOwnMessage(t *testing.T) {
	s, k := moduleStand(t)
	ctx := context.Background()
	id, err := s.b.SendModule(ctx, telegram.ModuleMessage{Module: "ops", Name: "Ops", Text: "Draft 1",
		Buttons: []telegram.ModuleButton{{ID: "yes", Label: "Approve"}, {ID: "no", Label: "Skip"}}})
	if err != nil {
		t.Fatal(err)
	}
	s.message(1)

	// Text only: editMessageText, the buttons kept in their order.
	if err := s.b.EditModule(ctx, telegram.ModuleEdit{Module: "ops", Name: "Ops", MessageID: id, Text: ptr("Draft 1 — approved")}); err != nil {
		t.Fatal(err)
	}
	e, _ := lastEdit(s, id)
	if e.Method != "editMessageText" || e.Text != "🧩 <b>Ops</b>\nDraft 1 — approved" || e.ParseMode != "HTML" || strings.Join(e.Buttons, ",") != "x:yes,x:no" {
		t.Fatalf("text edit %+v", e)
	}

	// Buttons only: editMessageReplyMarkup with the new ones.
	if err := s.b.EditModule(ctx, telegram.ModuleEdit{Module: "ops", MessageID: id, Buttons: &[]telegram.ModuleButton{{ID: "undo", Label: "Undo"}}}); err != nil {
		t.Fatal(err)
	}
	if e, _ = lastEdit(s, id); e.Method != "editMessageReplyMarkup" || strings.Join(e.Buttons, ",") != "x:undo" {
		t.Fatalf("buttons edit %+v", e)
	}

	// A press on the new button is the module's, in its store.
	s.bot.Press(owner, id, "x:undo")
	key := "ops/" + strconv.FormatInt(id, 10) + "-1"
	eventually(t, "the press on an edited button", func() bool { _, ok := k.get(key); return ok })
	if d, _ := k.get(key); d["button"] != "undo" {
		t.Fatalf("doc %v", d)
	}
	eventually(t, "the chosen mark", func() bool {
		e, _ := lastEdit(s, id)
		return strings.Join(e.Buttons, ",") == "-"
	})
	// A button the edit replaced is out of date now.
	s.bot.Press(owner, id, "x:yes")
	eventually(t, "the out-of-date toast", func() bool {
		a := s.bot.Answers()
		return len(a) > 0 && a[len(a)-1] == "That button is out of date."
	})

	// A text edit after the press keeps the chosen mark.
	if err := s.b.EditModule(ctx, telegram.ModuleEdit{Module: "ops", MessageID: id, Text: ptr("Done")}); err != nil {
		t.Fatal(err)
	}
	if e, _ = lastEdit(s, id); e.Method != "editMessageText" || strings.Join(e.Buttons, ",") != "-" {
		t.Fatalf("text edit after a press %+v", e)
	}

	// An empty list removes the keyboard.
	if err := s.b.EditModule(ctx, telegram.ModuleEdit{Module: "ops", MessageID: id, Buttons: &[]telegram.ModuleButton{}}); err != nil {
		t.Fatal(err)
	}
	if e, _ = lastEdit(s, id); e.Method != "editMessageReplyMarkup" || len(e.Buttons) != 0 {
		t.Fatalf("remove edit %+v", e)
	}
	if ref, _ := s.b.Store.Lookup(id); len(ref.Buttons) != 0 || ref.Chosen != "" {
		t.Fatalf("ref after removing %+v", ref)
	}

	// Telegram's "message is not modified" is success.
	s.bot.EditsUnchanged(1)
	_, before := lastEdit(s, id)
	if err := s.b.EditModule(ctx, telegram.ModuleEdit{Module: "ops", MessageID: id, Text: ptr("Done")}); err != nil {
		t.Fatalf("not modified: %v", err)
	}
	if _, after := lastEdit(s, id); after != before {
		t.Fatalf("the unchanged edit was recorded as made")
	}
}

// A module edits and replies under only what it sent: another module's
// message, the bridge's own and an unknown id are all ErrNotModuleMessage,
// and nothing reaches Telegram for them.
func TestAModuleTouchesOnlyItsOwnMessages(t *testing.T) {
	s, _ := moduleStand(t)
	ctx := context.Background()
	mine, err := s.b.SendModule(ctx, telegram.ModuleMessage{Module: "ops", Text: "mine"})
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := s.b.SendModule(ctx, telegram.ModuleMessage{Module: "ads", Text: "theirs"})
	if err != nil {
		t.Fatal(err)
	}
	bridges := s.deliver("own", "")
	before := len(s.bot.Sent())
	for _, id := range []int64{theirs, bridges, 9999, 0} {
		if err := s.b.EditModule(ctx, telegram.ModuleEdit{Module: "ops", MessageID: id, Text: ptr("x")}); !errors.Is(err, telegram.ErrNotModuleMessage) {
			t.Errorf("edit %d: %v", id, err)
		}
		if id == 0 {
			continue
		}
		if _, err := s.b.SendModule(ctx, telegram.ModuleMessage{Module: "ops", Text: "x", ReplyTo: id}); !errors.Is(err, telegram.ErrNotModuleMessage) {
			t.Errorf("reply under %d: %v", id, err)
		}
	}
	if n := len(s.bot.Sent()); n != before {
		t.Fatalf("%d calls reached Telegram for messages that are not the module's", n-before)
	}

	// An edit needs something to change, and the same limits as a send.
	for _, bad := range []telegram.ModuleEdit{
		{Module: "ops", MessageID: mine},
		{Module: "ops", MessageID: mine, Text: ptr("  ")},
		{Module: "ops", MessageID: mine, Text: ptr(strings.Repeat("é", telegram.ModuleTextMax+1))},
		{Module: "ops", MessageID: mine, Buttons: &[]telegram.ModuleButton{{ID: "a b", Label: "x"}}},
	} {
		if err := s.b.EditModule(ctx, bad); !errors.Is(err, telegram.ErrModuleMessage) {
			t.Errorf("%+v: %v", bad, err)
		}
	}

	// A reply under its own message is threaded under it.
	id, err := s.b.SendModule(ctx, telegram.ModuleMessage{Module: "ops", Text: "follow-up", ReplyTo: mine})
	if err != nil {
		t.Fatal(err)
	}
	msgs := s.bot.Messages()
	if m := msgs[len(msgs)-1]; m.MessageID != id || m.ReplyTo != mine {
		t.Fatalf("reply %+v", m)
	}
}

// Which module sent a message, and its buttons in order, are kept in the
// bridge's file: after a restart the module may still edit it.
func TestModuleOwnershipOutlivesARestart(t *testing.T) {
	dir := t.TempDir()
	telegram.OpenStore(dir).Remember(telegram.Ref{MessageID: 41, Kind: "module", Module: "ops",
		Buttons: map[string]string{"b": "Second", "a": "First"}, Order: []string{"b", "a"}})

	h := newHost()
	h.chat = "777"
	bot := telegramtest.New(token, "caprock_test_bot")
	t.Cleanup(bot.Close)
	b := telegram.New(h, dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	b.Base = bot.URL()
	if err := b.EditModule(context.Background(), telegram.ModuleEdit{Module: "ops", MessageID: 41, Text: ptr("after a restart")}); err != nil {
		t.Fatal(err)
	}
	sent := bot.Sent()
	if len(sent) != 1 || sent[0].Method != "editMessageText" || strings.Join(sent[0].Buttons, ",") != "x:b,x:a" {
		t.Fatalf("sent %+v", sent)
	}
	if err := b.EditModule(context.Background(), telegram.ModuleEdit{Module: "ads", MessageID: 41, Text: ptr("x")}); !errors.Is(err, telegram.ErrNotModuleMessage) {
		t.Fatalf("another module after a restart: %v", err)
	}
}
