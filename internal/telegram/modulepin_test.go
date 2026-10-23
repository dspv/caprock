package telegram_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/telegram"
	"github.com/dspv/caprock/internal/telegram/telegramtest"
)

// One card, edited again and again as the owner works through a batch:
// each step lands, each stays the module's, and a press on the last
// buttons it had is routed to the module's store.
func TestAModuleMessageIsEditedManyTimes(t *testing.T) {
	s, k := moduleStand(t)
	ctx := context.Background()
	id, err := s.b.SendModule(ctx, telegram.ModuleMessage{Module: "ops", Name: "Ops", Text: "Draft 3",
		Buttons: []telegram.ModuleButton{{ID: "ok", Label: "Approve"}, {ID: "skip", Label: "Skip"}}})
	if err != nil {
		t.Fatal(err)
	}
	s.message(1)
	none := []telegram.ModuleButton{}
	steps := []struct {
		edit    telegram.ModuleEdit
		text    string
		buttons string
	}{
		{telegram.ModuleEdit{Text: ptr("Draft 3 · checking"), Buttons: &none}, "Draft 3 · checking", ""},
		{telegram.ModuleEdit{Text: ptr("Draft 3 · ready"), Buttons: &[]telegram.ModuleButton{{ID: "ship", Label: "Ship"}, {ID: "hold", Label: "Hold"}}}, "Draft 3 · ready", "x:ship,x:hold"},
	}
	for i, st := range steps {
		e := st.edit
		e.Module, e.Name, e.MessageID = "ops", "Ops", id
		if err := s.b.EditModule(ctx, e); err != nil {
			t.Fatalf("step %d: %v", i+1, err)
		}
		got, _ := lastEdit(s, id)
		if got.Method != "editMessageText" || got.Text != "🧩 <b>Ops</b>\n"+st.text || strings.Join(got.Buttons, ",") != st.buttons {
			t.Fatalf("step %d sent %+v", i+1, got)
		}
		// Still the module's, and only its.
		if err := s.b.EditModule(ctx, telegram.ModuleEdit{Module: "ads", MessageID: id, Text: ptr("x")}); !errors.Is(err, telegram.ErrNotModuleMessage) {
			t.Fatalf("step %d, another module: %v", i+1, err)
		}
	}

	// A press on the last buttons, and one on a button two edits old.
	s.bot.Press(owner, id, "x:skip")
	eventually(t, "the out-of-date toast", func() bool {
		a := s.bot.Answers()
		return len(a) > 0 && a[len(a)-1] == "That button is out of date."
	})
	s.bot.Press(owner, id, "x:ship")
	key := "ops/" + strconv.FormatInt(id, 10) + "-1"
	eventually(t, "the press in the store", func() bool { _, ok := k.get(key); return ok })
	if d, _ := k.get(key); d["button"] != "ship" {
		t.Fatalf("doc %v", d)
	}
	// The press is handled in full, its mark made, before the module's
	// final edit: the answer reaches the store before the mark does.
	eventually(t, "the chosen mark", func() bool {
		e, _ := lastEdit(s, id)
		return e.Method == "editMessageReplyMarkup" && strings.Join(e.Buttons, ",") == "-"
	})

	// The final text, its buttons gone.
	if err := s.b.EditModule(ctx, telegram.ModuleEdit{Module: "ops", Name: "Ops", MessageID: id, Text: ptr("Draft 3 · shipped"), Buttons: &none}); err != nil {
		t.Fatal(err)
	}
	if got, n := lastEdit(s, id); got.Method != "editMessageText" || got.Text != "🧩 <b>Ops</b>\nDraft 3 · shipped" || len(got.Buttons) != 0 || n < 4 {
		t.Fatalf("final edit %+v (%d edits)", got, n)
	}
	if ref, _ := s.b.Store.Lookup(id); ref.Module != "ops" || len(ref.Buttons) != 0 {
		t.Fatalf("ref %+v", ref)
	}
}

// A module that answers a press at once, before the press has put its
// "✓ <label>" under the message, keeps its answer: the late mark never
// goes over the newer text and buttons. The module edits from inside the
// store write, so the order is the one that raced on a slow runner.
func TestALatePressMarkKeepsTheModulesEdit(t *testing.T) {
	k := &kept{docs: map[string]map[string]any{}}
	h := newHost()
	h.chat = "777"
	h.alertsOn = false
	var b *telegram.Bridge
	var answered error
	s := newStand(t, h, func(br *telegram.Bridge) {
		b = br
		br.ModuleAnswer = func(ctx context.Context, module, doc string, data map[string]any) error {
			if err := k.answer(ctx, module, doc, data); err != nil {
				return err
			}
			id, _ := strconv.ParseInt(strings.SplitN(doc, "-", 2)[0], 10, 64)
			none := []telegram.ModuleButton{}
			answered = b.EditModule(ctx, telegram.ModuleEdit{Module: "ops", Name: "Ops", MessageID: id, Text: ptr("Shipped"), Buttons: &none})
			return nil
		}
	})
	ctx := context.Background()
	id, err := s.b.SendModule(ctx, telegram.ModuleMessage{Module: "ops", Name: "Ops", Text: "Ship it?",
		Buttons: []telegram.ModuleButton{{ID: "ship", Label: "Ship"}}})
	if err != nil {
		t.Fatal(err)
	}
	s.message(1)
	s.bot.Press(owner, id, "x:ship")
	// Updates are handled one at a time: once a second press is answered,
	// the first one's handler has returned, its mark made or not.
	s.bot.Press(owner, id, "x:ship")
	eventually(t, "the second press answered", func() bool {
		a := s.bot.Answers()
		return len(a) > 0 && a[len(a)-1] == "That button is out of date."
	})
	if answered != nil {
		t.Fatal(answered)
	}
	got, n := lastEdit(s, id)
	if got.Method != "editMessageText" || got.Text != "🧩 <b>Ops</b>\nShipped" || len(got.Buttons) != 0 || n != 1 {
		t.Fatalf("last edit %+v (%d edits)", got, n)
	}
	if ref, _ := s.b.Store.Lookup(id); len(ref.Buttons) != 0 || ref.Chosen != "" {
		t.Fatalf("ref %+v", ref)
	}
}

// A module holds one pin: pinning another message unpins its previous
// one, and never another module's; unpinning is its own message only.
func TestAModuleHoldsOnePin(t *testing.T) {
	s, _ := moduleStand(t)
	ctx := context.Background()
	a, err := s.b.SendModule(ctx, telegram.ModuleMessage{Module: "ops", Text: "Batch 1", Pin: true})
	if err != nil {
		t.Fatal(err)
	}
	pin := lastCall(s)
	if pin.Method != "pinChatMessage" || pin.ReplyTo != a || !pin.Silent || !s.bot.Pinned(a) {
		t.Fatalf("pin %+v", pin)
	}
	theirs, err := s.b.SendModule(ctx, telegram.ModuleMessage{Module: "ads", Text: "Theirs", Pin: true})
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.b.SendModule(ctx, telegram.ModuleMessage{Module: "ops", Text: "Batch 2"})
	if err != nil {
		t.Fatal(err)
	}
	if s.bot.Pinned(b) {
		t.Fatal("pinned without pin")
	}
	// Pin-only PATCH: the new one pinned, the module's old one unpinned,
	// the other module's left.
	if err := s.b.EditModule(ctx, telegram.ModuleEdit{Module: "ops", MessageID: b, Pin: ptr(true)}); err != nil {
		t.Fatal(err)
	}
	if !s.bot.Pinned(b) || s.bot.Pinned(a) || !s.bot.Pinned(theirs) {
		t.Fatalf("pins after re-pinning: a=%v b=%v theirs=%v", s.bot.Pinned(a), s.bot.Pinned(b), s.bot.Pinned(theirs))
	}
	if p := s.b.Store.Get().ModulePins; p["ops"] != b || p["ads"] != theirs {
		t.Fatalf("recorded pins %v", p)
	}
	// Another module cannot pin or unpin it.
	if err := s.b.EditModule(ctx, telegram.ModuleEdit{Module: "ads", MessageID: b, Pin: ptr(false)}); !errors.Is(err, telegram.ErrNotModuleMessage) {
		t.Fatalf("another module unpinning: %v", err)
	}
	// Unpinning its own.
	if err := s.b.EditModule(ctx, telegram.ModuleEdit{Module: "ops", MessageID: b, Pin: ptr(false)}); err != nil {
		t.Fatal(err)
	}
	if s.bot.Pinned(b) || !s.bot.Pinned(theirs) {
		t.Fatal("unpin touched the wrong pin")
	}
	if p := s.b.Store.Get().ModulePins; p["ops"] != 0 || p["ads"] != theirs {
		t.Fatalf("recorded pins after unpinning %v", p)
	}
	for _, c := range s.bot.Sent() {
		if c.Method == "unpinChatMessage" && c.ReplyTo == theirs {
			t.Fatal("another module's pin was unpinned")
		}
	}
}

// Telegram refusing a pin is the caller's to read, with the message id of
// what was sent; the module's previous pin stays.
func TestARefusedPinSaysSo(t *testing.T) {
	s, _ := moduleStand(t)
	ctx := context.Background()
	a, err := s.b.SendModule(ctx, telegram.ModuleMessage{Module: "ops", Text: "Batch 1", Pin: true})
	if err != nil {
		t.Fatal(err)
	}
	s.bot.RefusePins()
	b, err := s.b.SendModule(ctx, telegram.ModuleMessage{Module: "ops", Text: "Batch 2", Pin: true})
	var pe *telegram.PinError
	if !errors.As(err, &pe) || pe.MessageID != b || b == 0 || !strings.Contains(err.Error(), "not enough rights") || strings.Contains(err.Error(), token) {
		t.Fatalf("refused pin: id %d, %v", b, err)
	}
	if !s.bot.Pinned(a) || s.b.Store.Get().ModulePins["ops"] != a {
		t.Fatal("the previous pin was lost")
	}
	if err := s.b.EditModule(ctx, telegram.ModuleEdit{Module: "ops", MessageID: b, Pin: ptr(true)}); err == nil || !strings.Contains(err.Error(), "not enough rights") {
		t.Fatalf("refused PATCH pin: %v", err)
	}
}

// The module's pin is kept in telegram.json: after a restart, pinning
// another message still unpins it.
func TestAModulePinOutlivesARestart(t *testing.T) {
	dir := t.TempDir()
	st := telegram.OpenStore(dir)
	st.Remember(telegram.Ref{MessageID: 41, Kind: "module", Module: "ops"})
	st.Remember(telegram.Ref{MessageID: 42, Kind: "module", Module: "ops"})
	_ = st.Update(func(s *telegram.State) { s.ModulePins = map[string]int64{"ops": 41, "ads": 7} })

	h := newHost()
	h.chat = "777"
	bot := telegramtest.New(token, "caprock_test_bot")
	t.Cleanup(bot.Close)
	b := telegram.New(h, dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	b.Base = bot.URL()
	if err := b.EditModule(context.Background(), telegram.ModuleEdit{Module: "ops", MessageID: 42, Pin: ptr(true)}); err != nil {
		t.Fatal(err)
	}
	var calls []string
	for _, c := range bot.Sent() {
		calls = append(calls, c.Method+":"+strconv.FormatInt(c.ReplyTo, 10))
	}
	if strings.Join(calls, ",") != "pinChatMessage:42,unpinChatMessage:41" {
		t.Fatalf("calls %v", calls)
	}
	if p := telegram.OpenStore(dir).Get().ModulePins; p["ops"] != 42 || p["ads"] != 7 {
		t.Fatalf("pins on disk %v", p)
	}
}

func lastCall(s *stand) telegramtest.Sent {
	all := s.bot.Sent()
	if len(all) == 0 {
		return telegramtest.Sent{}
	}
	return all[len(all)-1]
}
