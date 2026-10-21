package telegram_test

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/dspv/caprock/internal/telegram"
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
