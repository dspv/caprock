package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/telegram"
	"github.com/dspv/caprock/internal/telegram/telegramtest"
)

// moduleBridge is a module env with the real bridge in front of a fake
// Telegram, its answers written to the env's own module store.
func moduleBridge(t *testing.T) (*moduleEnv, *telegramtest.Bot) {
	t.Helper()
	const token = "4242:SECRET-module-edit-token"
	bot := telegramtest.New(token, "my_caprock_bot")
	t.Cleanup(bot.Close)
	b := telegram.New(&tgHost{token: token, chat: "777"}, t.TempDir(), nil)
	b.Base = bot.URL()
	b.PollWait = time.Second
	b.Out.Gap = 5 * time.Millisecond
	e := newModuleEnv(t, func(d *Deps) { d.Telegram = b })
	b.ModuleAnswer = func(ctx context.Context, module, doc string, data map[string]any) error {
		raw, err := json.Marshal(data)
		if err != nil {
			return err
		}
		_, err = store.SetModuleDoc(ctx, e.st.DB(), module, telegram.ModuleCollection, doc, raw, time.Now().UnixMilli())
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go b.Run(ctx)
	e.install(t, "alpha", "Alpha")
	e.install(t, "beta", "Beta")
	e.admin.key = e.key(`"alpha","beta"`)
	return e, bot
}

func (e *moduleEnv) sendTelegram(t *testing.T, module, body string) int64 {
	t.Helper()
	var out map[string]int64
	if code := e.send(t, http.MethodPost, "/v1/x/"+module+"/telegram", body, &out); code != 200 || out["message_id"] == 0 {
		t.Fatalf("send as %s: %d %v", module, code, out)
	}
	return out["message_id"]
}

func lastCall(bot *telegramtest.Bot) telegramtest.Sent {
	s := bot.Sent()
	if len(s) == 0 {
		return telegramtest.Sent{}
	}
	return s[len(s)-1]
}

// PATCH /v1/x/<id>/telegram/<message_id> edits the module's own message,
// and only that: the status codes a module sees.
func TestAModuleEditsItsTelegramMessage(t *testing.T) {
	e, bot := moduleBridge(t)
	id := e.sendTelegram(t, "alpha", `{"text":"Draft 7","buttons":[{"id":"ok","label":"Approve"},{"id":"skip","label":"Skip"}]}`)
	path := "/v1/x/alpha/telegram/" + strconv.FormatInt(id, 10)

	var out map[string]int64
	if code := e.send(t, http.MethodPatch, path, `{"text":"Draft 7 · approved"}`, &out); code != 200 || out["message_id"] != id {
		t.Fatalf("text edit: %d %v", code, out)
	}
	if c := lastCall(bot); c.Method != "editMessageText" || c.Text != "🧩 <b>Alpha</b>\nDraft 7 · approved" || strings.Join(c.Buttons, ",") != "x:ok,x:skip" {
		t.Fatalf("text edit sent %+v", c)
	}
	if code := e.send(t, http.MethodPatch, path, `{"buttons":[{"id":"undo","label":"Undo"}]}`, nil); code != 200 {
		t.Fatalf("buttons edit: %d", code)
	}
	if c := lastCall(bot); c.Method != "editMessageReplyMarkup" || strings.Join(c.Buttons, ",") != "x:undo" {
		t.Fatalf("buttons edit sent %+v", c)
	}

	// A press on the edited button lands in the module's store.
	bot.Press(777, id, "x:undo")
	doc := "/v1/x/alpha/docs/telegram/" + strconv.FormatInt(id, 10) + "-1"
	deadline := time.Now().Add(5 * time.Second)
	var got struct {
		Data map[string]any `json:"data"`
	}
	for e.get(t, doc, &got) != 200 {
		if time.Now().After(deadline) {
			t.Fatal("the press never reached the store")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got.Data["button"] != "undo" {
		t.Fatalf("stored %v", got.Data)
	}

	if code := e.send(t, http.MethodPatch, path, `{"buttons":[]}`, nil); code != 200 {
		t.Fatalf("remove buttons: %d", code)
	}
	if c := lastCall(bot); c.Method != "editMessageReplyMarkup" || len(c.Buttons) != 0 {
		t.Fatalf("remove sent %+v", c)
	}
	bot.EditsUnchanged(1)
	if code := e.send(t, http.MethodPatch, path, `{"text":"Draft 7 · approved"}`, nil); code != 200 {
		t.Fatalf("not modified: %d", code)
	}

	before := len(bot.Sent())
	for _, c := range []struct {
		path, body string
		want       int
	}{
		{path, `{}`, 400},
		{path, `{"text":null,"buttons":null}`, 400},
		{path, `{"text":""}`, 400},
		{path, `{"buttons":[{"id":"a b","label":"x"}]}`, 400},
		{path, `not json`, 400},
		{"/v1/x/beta/telegram/" + strconv.FormatInt(id, 10), `{"text":"x"}`, 404}, // another module's
		{"/v1/x/alpha/telegram/999999", `{"text":"x"}`, 404},                      // unknown
		{"/v1/x/alpha/telegram/abc", `{"text":"x"}`, 404},
		{"/v1/x/gamma/telegram/" + strconv.FormatInt(id, 10), `{"text":"x"}`, 403}, // not in the key
	} {
		if code := e.send(t, http.MethodPatch, c.path, c.body, nil); code != c.want {
			t.Errorf("PATCH %s %s: %d, want %d", c.path, c.body, code, c.want)
		}
	}
	if n := len(bot.Sent()); n != before {
		t.Fatalf("%d refused edits reached Telegram", n-before)
	}
}

// reply_to_message_id threads a message under the module's own; under any
// other it is a 404 and nothing is sent.
func TestAModuleRepliesUnderItsOwnMessage(t *testing.T) {
	e, bot := moduleBridge(t)
	mine := e.sendTelegram(t, "alpha", `{"text":"Batch of 3"}`)
	theirs := e.sendTelegram(t, "beta", `{"text":"Other"}`)

	id := e.sendTelegram(t, "alpha", `{"text":"Card 1","reply_to_message_id":`+strconv.FormatInt(mine, 10)+`}`)
	msgs := bot.Messages()
	if m := msgs[len(msgs)-1]; m.MessageID != id || m.ReplyTo != mine {
		t.Fatalf("reply %+v", m)
	}
	before := len(bot.Messages())
	for _, to := range []int64{theirs, 999999} {
		if code := e.send(t, http.MethodPost, "/v1/x/alpha/telegram", `{"text":"x","reply_to_message_id":`+strconv.FormatInt(to, 10)+`}`, nil); code != 404 {
			t.Errorf("reply under %d: %d", to, code)
		}
	}
	if code := e.send(t, http.MethodPost, "/v1/x/alpha/telegram", `{"text":"x","reply_to_message_id":-4}`, nil); code != 400 {
		t.Errorf("a negative id: %d", code)
	}
	if n := len(bot.Messages()); n != before {
		t.Fatalf("%d refused replies were sent", n-before)
	}
}

// pin on POST and PATCH: one pin per module, a refused pin a 502 carrying
// Telegram's words and the sent message's id, never the token.
func TestAModulePinsOverHTTP(t *testing.T) {
	e, bot := moduleBridge(t)
	a := e.sendTelegram(t, "alpha", `{"text":"Batch 1","pin":true}`)
	theirs := e.sendTelegram(t, "beta", `{"text":"Theirs","pin":true}`)
	b := e.sendTelegram(t, "alpha", `{"text":"Batch 2"}`)
	bPath := "/v1/x/alpha/telegram/" + strconv.FormatInt(b, 10)
	if code := e.send(t, http.MethodPatch, bPath, `{"pin":true}`, nil); code != 200 {
		t.Fatalf("PATCH pin: %d", code)
	}
	if !bot.Pinned(b) || bot.Pinned(a) || !bot.Pinned(theirs) {
		t.Fatalf("pins: a=%v b=%v theirs=%v", bot.Pinned(a), bot.Pinned(b), bot.Pinned(theirs))
	}
	if code := e.send(t, http.MethodPatch, "/v1/x/beta/telegram/"+strconv.FormatInt(b, 10), `{"pin":false}`, nil); code != 404 {
		t.Fatalf("another module unpinning: %d", code)
	}
	if code := e.send(t, http.MethodPatch, bPath, `{"pin":false}`, nil); code != 200 || bot.Pinned(b) || !bot.Pinned(theirs) {
		t.Fatalf("PATCH unpin: %d", code)
	}

	bot.RefusePins()
	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/v1/x/alpha/telegram", strings.NewReader(`{"text":"Batch 3","pin":true}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Error     string `json:"error"`
		MessageID int64  `json:"message_id"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != 502 || out.MessageID == 0 || !strings.Contains(out.Error, "not enough rights") || strings.Contains(out.Error, "SECRET") {
		t.Fatalf("refused pin: %d %+v", resp.StatusCode, out)
	}
	if code := e.send(t, http.MethodPatch, "/v1/x/alpha/telegram/"+strconv.FormatInt(out.MessageID, 10), `{"pin":true}`, nil); code != 502 {
		t.Fatalf("refused PATCH pin: %d", code)
	}
}
