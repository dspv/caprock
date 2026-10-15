package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/dspv/caprock/internal/telegram"
	"github.com/dspv/caprock/internal/telegram/telegramtest"
)

// tgHost is the least a bridge needs to be set up through the API.
type tgHost struct {
	mu          sync.Mutex
	token, chat string
}

func (h *tgHost) Bot() (string, string)   { h.mu.Lock(); defer h.mu.Unlock(); return h.token, h.chat }
func (h *tgHost) SaveBot(t string) error  { h.mu.Lock(); h.token = t; h.mu.Unlock(); return nil }
func (h *tgHost) SaveChat(c string) error { h.mu.Lock(); h.chat = c; h.mu.Unlock(); return nil }
func (h *tgHost) Licensed() bool          { return false }
func (h *tgHost) ChatOn() bool            { return false }
func (h *tgHost) AlertsOn() bool          { return false }
func (h *tgHost) Sessions(context.Context) ([]telegram.Live, error) {
	return nil, nil
}
func (h *tgHost) Session(context.Context, string) (telegram.Live, bool) {
	return telegram.Live{}, false
}
func (h *tgHost) Type(string, string) error         { return nil }
func (h *tgHost) Answer(string, string, bool) error { return nil }
func (h *tgHost) Stop(string) error                 { return nil }
func (h *tgHost) Projects(context.Context) ([]telegram.Project, error) {
	return nil, nil
}
func (h *tgHost) SpawnMode() string { return "" }
func (h *tgHost) Start(context.Context, string, string, string) (string, error) {
	return "", nil
}

// The token goes in through PUT, is checked with Telegram, and never comes
// back out: the status carries a mask and the bot's name.
func TestTelegramSetupNeverReturnsTheToken(t *testing.T) {
	const token = "4242:SECRET-api-test-token"
	bot := telegramtest.New(token, "my_caprock_bot")
	defer bot.Close()
	h := &tgHost{}
	b := telegram.New(h, t.TempDir(), nil)
	b.Base = bot.URL()
	srv := httptest.NewServer(New(Deps{Version: "t", Token: "tok", Telegram: b}))
	defer srv.Close()

	call := func(method, path, body string) (int, string) {
		req, _ := http.NewRequest(method, srv.URL+path, bytes.NewReader([]byte(body)))
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(raw)
	}
	if code, body := call(http.MethodPut, "/v1/telegram/token", `{"token":"1:wrong"}`); code != http.StatusBadRequest || !strings.Contains(body, "does not recognise") {
		t.Fatalf("a wrong token: %d %s", code, body)
	}
	code, body := call(http.MethodPut, "/v1/telegram/token", `{"token":"`+token+`"}`)
	if code != http.StatusOK || strings.Contains(body, "SECRET") {
		t.Fatalf("connect: %d %s", code, body)
	}
	var st telegram.Status
	_ = json.Unmarshal([]byte(body), &st)
	if !st.BotSet || st.BotUsername != "my_caprock_bot" || st.TokenMasked != "••••••oken" {
		t.Fatalf("status = %+v", st)
	}
	code, body = call(http.MethodPost, "/v1/telegram/pair", ``)
	_ = json.Unmarshal([]byte(body), &st)
	if code != http.StatusOK || st.Pairing == nil || len(st.Pairing.Code) != 6 || !strings.HasPrefix(st.Pairing.Link, "https://t.me/my_caprock_bot?start=") {
		t.Fatalf("pair: %d %s", code, body)
	}
	if _, body := call(http.MethodGet, "/v1/telegram", ``); strings.Contains(body, "SECRET") {
		t.Fatalf("GET carried the token: %s", body)
	}
	if code, _ := call(http.MethodDelete, "/v1/telegram", ``); code != http.StatusOK {
		t.Fatalf("disconnect: %d", code)
	}
	if tok, _ := h.Bot(); tok != "" {
		t.Fatal("disconnect kept the token")
	}
}

// A share card goes to the paired chat as a photo with its caption, only
// once a chat is paired; anything that is not a PNG is refused before
// Telegram is asked.
func TestTelegramPhotoGoesToThePairedChat(t *testing.T) {
	const token = "4242:SECRET-photo-token"
	bot := telegramtest.New(token, "my_caprock_bot")
	defer bot.Close()
	h := &tgHost{token: token}
	b := telegram.New(h, t.TempDir(), nil)
	b.Base = bot.URL()
	srv := httptest.NewServer(New(Deps{Version: "t", Token: "tok", Telegram: b}))
	defer srv.Close()

	png := append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, []byte("card")...)
	send := func(body string) (int, string) {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/telegram/photo", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(raw)
	}
	good := `{"png":"` + base64.StdEncoding.EncodeToString(png) + `","caption":"a private repo: 2.9 PRs/day — via caprock.dev"}`

	if code, body := send(good); code != http.StatusConflict || strings.Contains(body, "SECRET") {
		t.Fatalf("no chat paired: %d %s", code, body)
	}
	_ = h.SaveChat("777")
	if code, _ := send(`{"png":"` + base64.StdEncoding.EncodeToString([]byte("GIF89a")) + `"}`); code != http.StatusBadRequest {
		t.Fatalf("a GIF: %d", code)
	}
	if code, _ := send(`{"png":"not base64!"}`); code != http.StatusBadRequest {
		t.Fatalf("bad base64: %d", code)
	}
	if code, _ := send(`{}`); code != http.StatusBadRequest {
		t.Fatalf("empty: %d", code)
	}
	if n := len(bot.Sent()); n != 0 {
		t.Fatalf("a refused body reached Telegram: %d calls", n)
	}
	if code, body := send(good); code != http.StatusOK || !strings.Contains(body, `"sent":true`) {
		t.Fatalf("send: %d %s", code, body)
	}
	sent := bot.Sent()
	if len(sent) != 1 || sent[0].Method != "sendPhoto" || sent[0].ChatID != "777" ||
		sent[0].Text != "a private repo: 2.9 PRs/day — via caprock.dev" || !bytes.Equal(sent[0].Photo, png) {
		t.Fatalf("sent = %+v", sent)
	}
}
