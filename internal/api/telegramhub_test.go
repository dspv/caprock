package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/telegram"
	"github.com/dspv/caprock/internal/telegram/telegramtest"
)

// Only another computer of the owner's, allowed here, sends through this
// machine's bot (ADR-047, amended 2026-11-27): the chat names it by its
// device record here, never by what it says; a phone, a computer still
// waiting and the machine itself are refused.
func TestOnlyAnAllowedComputerSendsThroughTheBot(t *testing.T) {
	const token = "4242:SECRET-hub-test-token"
	bot := telegramtest.New(token, "hub_bot")
	defer bot.Close()
	b := telegram.New(&tgHost{token: token, chat: "777"}, t.TempDir(), nil)
	b.Base = bot.URL()
	b.Out.Gap = 10 * time.Millisecond
	// Stopped and waited for before the temporary directory goes, so
	// Windows can delete it.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		b.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})

	s, ps, _, phone := pairedPhones(t, Deps{Telegram: b})
	mac := pairedComputer(t, ps, "MacBook", true)
	waiting := pairedComputer(t, ps, "Stranger", false)
	const msg = `{"id":"m1","text":"<b>hello</b>","parse_mode":"HTML","buttons":[[{"text":"Approve","action":"approve"}]]}`

	for name, tok := range map[string]string{"a phone": phone.Token, "a waiting computer": waiting.Token} {
		if w := serve(s, fromDevice("POST", "/v1/telegram/hub/messages", msg, tok)); w.Code != 403 {
			t.Errorf("%s posted: %d %s", name, w.Code, w.Body)
		}
	}
	if w := serve(s, local("POST", "/v1/telegram/hub/messages", msg)); w.Code != 403 {
		t.Errorf("the machine itself posted: %d %s", w.Code, w.Body)
	}
	if n := len(bot.Messages()); n != 0 {
		t.Fatalf("%d messages reached Telegram before an allowed computer asked", n)
	}

	w := serve(s, fromDevice("GET", "/v1/telegram/hub", "", mac.Token))
	var info telegram.HubInfo
	if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil || w.Code != 200 || !info.Holder {
		t.Fatalf("hub info: %d %s", w.Code, w.Body)
	}
	w = serve(s, fromDevice("POST", "/v1/telegram/hub/messages", msg, mac.Token))
	if w.Code != 200 {
		t.Fatalf("post: %d %s", w.Code, w.Body)
	}
	got := bot.Messages()
	if len(got) != 1 || !strings.HasPrefix(got[0].Text, "🖥 <b>MacBook</b>\n<b>hello</b>") || strings.Join(got[0].Buttons, ",") != "h:0" {
		t.Fatalf("sent = %+v", got)
	}
	// A press goes back to that computer alone.
	bot.Press(777, got[0].MessageID, "h:0")
	deadline := time.Now().Add(5 * time.Second)
	for {
		w = serve(s, fromDevice("GET", "/v1/telegram/hub/presses?wait=1", "", mac.Token))
		var out struct {
			Presses []telegram.HubPress `json:"presses"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		if len(out.Presses) == 1 && out.Presses[0].ID == "m1" && out.Presses[0].Action == telegram.ActApprove {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no press came back: %d %s", w.Code, w.Body)
		}
	}
	// The sender's own routes are this machine's alone.
	for _, p := range [][2]string{{"GET", "/v1/telegram/holders"}, {"PUT", "/v1/telegram/via"}, {"POST", "/v1/telegram/via/take"}} {
		if w := serve(s, fromDevice(p[0], p[1], `{"machine":"x"}`, mac.Token)); w.Code != 403 {
			t.Errorf("a computer reached %s %s: %d", p[0], p[1], w.Code)
		}
	}
}
