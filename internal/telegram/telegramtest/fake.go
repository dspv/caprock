// Package telegramtest is a stand-in for the Telegram Bot API, for tests and
// preview stands: nothing in the suite ever talks to api.telegram.org.
package telegramtest

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/telegram"
)

// Sent is one call the fake received that changes the chat: a message, an
// edit of its buttons, or a reaction.
type Sent struct {
	Method    string
	ChatID    string
	Text      string
	ParseMode string
	MessageID int64
	// ReplyTo is the message a sent one is threaded under; for an edit or a
	// reaction, the message it changes.
	ReplyTo int64
	// Buttons are the inline buttons' callback data (or "url:" + the URL),
	// row by row flattened.
	Buttons []string
	// ForceReply says the message asked for a reply.
	ForceReply bool
	Emoji      string
	// Photo is a sendPhoto's file; Text is then its caption.
	Photo []byte
	At    time.Time
}

// Bot is a fake Bot API serving one bot.
type Bot struct {
	Token    string
	Username string

	mu               sync.Mutex
	updates          []telegram.Update
	nextID           int64
	nextMsg          int64
	sent             []Sent
	calls            []string
	answers          []string // answerCallbackQuery texts
	limit            int      // the next limit calls answer 429
	retry            int      // their retry_after
	refuseURLButtons bool
	files            map[string]fakeFile
	notify           chan struct{}
	pollWait         time.Duration
	srv              *httptest.Server
}

// New starts a fake for a bot with this token and username. Close it when done.
func New(token, username string) *Bot {
	b := &Bot{Token: token, Username: username, nextID: 100, nextMsg: 1, notify: make(chan struct{}, 1), pollWait: 2 * time.Second}
	b.srv = httptest.NewServer(http.HandlerFunc(b.serve))
	return b
}

// URL is the base to give a telegram.Client.
func (b *Bot) URL() string { return b.srv.URL }

// Close stops the server.
func (b *Bot) Close() { b.srv.Close() }

// RateLimit makes the next n calls answer 429 with retry_after seconds.
func (b *Bot) RateLimit(n, retryAfter int) {
	b.mu.Lock()
	b.limit, b.retry = n, retryAfter
	b.mu.Unlock()
}

// RefuseURLButtons makes a message with a URL button fail as Telegram fails
// one whose address it will not open.
func (b *Bot) RefuseURLButtons() {
	b.mu.Lock()
	b.refuseURLButtons = true
	b.mu.Unlock()
}

func (b *Bot) push(u telegram.Update) {
	b.mu.Lock()
	b.nextID++
	u.UpdateID = b.nextID
	if u.Message != nil {
		u.Message.MessageID = 10_000 + b.nextID
	}
	b.updates = append(b.updates, u)
	b.mu.Unlock()
	select {
	case b.notify <- struct{}{}:
	default:
	}
}

// Say queues a text message from a private chat, as if someone typed it to
// the bot.
func (b *Bot) Say(chatID int64, firstName, text string) {
	b.SayIn(chatID, "private", firstName, text, 0)
}

// Reply queues a message sent with Telegram's Reply to the bot's message
// replyTo.
func (b *Bot) Reply(chatID int64, replyTo int64, text string) {
	b.SayIn(chatID, "private", "Owner", text, replyTo)
}

// SayIn queues a message from a chat of a given type ("private", "group").
func (b *Bot) SayIn(chatID int64, chatType, firstName, text string, replyTo int64) {
	m := &telegram.Message{Date: time.Now().Unix(), Text: text,
		From: &telegram.User{ID: chatID, FirstName: firstName},
		Chat: telegram.Chat{ID: chatID, Type: chatType, FirstName: firstName}}
	if chatType != "private" {
		m.Chat.Title = "A group"
	}
	if replyTo != 0 {
		m.ReplyTo = &telegram.Message{MessageID: replyTo, Chat: m.Chat}
	}
	b.push(telegram.Update{Message: m})
}

// Send queues a message from a private chat as m describes it — a forward,
// a photo, a voice note — with its date, sender and chat filled in.
func (b *Bot) Send(chatID int64, m telegram.Message) {
	m.Date = time.Now().Unix()
	m.From = &telegram.User{ID: chatID, FirstName: "Owner"}
	m.Chat = telegram.Chat{ID: chatID, Type: "private", FirstName: "Owner"}
	b.push(telegram.Update{Message: &m})
}

// AddFile makes a file fetchable with getFile under id, served at path on
// the file server.
func (b *Bot) AddFile(id, path string, data []byte) {
	b.mu.Lock()
	if b.files == nil {
		b.files = map[string]fakeFile{}
	}
	b.files[id] = fakeFile{path: path, data: data}
	b.mu.Unlock()
}

type fakeFile struct {
	path string
	data []byte
}

// SayOld queues a message dated age ago, as one sent while nobody read.
func (b *Bot) SayOld(chatID int64, text string, age time.Duration) {
	b.push(telegram.Update{Message: &telegram.Message{Date: time.Now().Add(-age).Unix(), Text: text,
		From: &telegram.User{ID: chatID, FirstName: "Owner"},
		Chat: telegram.Chat{ID: chatID, Type: "private", FirstName: "Owner"}}})
}

// Press queues a press of a button with data under the bot's message msgID.
func (b *Bot) Press(chatID, msgID int64, data string) {
	b.mu.Lock()
	id := "cb" + strconv.FormatInt(b.nextID+1, 10)
	b.mu.Unlock()
	b.push(telegram.Update{CallbackQuery: &telegram.CallbackQuery{ID: id, Data: data,
		From:    telegram.User{ID: chatID, FirstName: "Owner"},
		Message: &telegram.Message{MessageID: msgID, Chat: telegram.Chat{ID: chatID, Type: "private"}}}})
}

// Sent returns every message, edit and reaction so far.
func (b *Bot) Sent() []Sent {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]Sent(nil), b.sent...)
}

// Messages returns only the messages sent (no edits or reactions).
func (b *Bot) Messages() []Sent {
	var out []Sent
	for _, s := range b.Sent() {
		if s.Method == "sendMessage" {
			out = append(out, s)
		}
	}
	return out
}

// Answers returns the texts of every answerCallbackQuery, in order.
func (b *Bot) Answers() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.answers...)
}

// Calls returns every method called, in order.
func (b *Bot) Calls() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.calls...)
}

// Pending is how many queued updates have not been confirmed.
func (b *Bot) Pending() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.updates)
}

func (b *Bot) serve(w http.ResponseWriter, r *http.Request) {
	if rest, ok := strings.CutPrefix(r.URL.Path, "/file/bot"); ok {
		b.download(w, rest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	rest, ok := strings.CutPrefix(r.URL.Path, "/bot")
	tok, method, _ := strings.Cut(rest, "/")
	if !ok || tok != b.Token {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": 401, "description": "Unauthorized"})
		return
	}
	var in map[string]any
	if method == "sendPhoto" {
		b.photo(w, r)
		return
	}
	_ = json.NewDecoder(r.Body).Decode(&in)

	b.mu.Lock()
	b.calls = append(b.calls, method)
	if b.limit > 0 && method != "getUpdates" {
		b.limit--
		retry := b.retry
		b.mu.Unlock()
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": 429,
			"description": "Too Many Requests: retry after " + strconv.Itoa(retry), "parameters": map[string]any{"retry_after": retry}})
		return
	}
	refuseURL := b.refuseURLButtons
	b.mu.Unlock()

	switch method {
	case "getMe":
		ok200(w, telegram.User{ID: 42, IsBot: true, FirstName: "Caprock", Username: b.Username})
	case "getUpdates":
		ok200(w, b.poll(r, in))
	case "getFile":
		b.mu.Lock()
		f, ok := b.files[str(in["file_id"])]
		b.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": 400, "description": "Bad Request: invalid file_id"})
			return
		}
		ok200(w, map[string]any{"file_id": str(in["file_id"]), "file_path": f.path, "file_size": len(f.data)})
	case "sendMessage", "editMessageReplyMarkup", "editMessageText", "setMessageReaction":
		s := Sent{Method: method, ChatID: str(in["chat_id"]), Text: str(in["text"]), ParseMode: str(in["parse_mode"]), At: time.Now()}
		if mk, ok := in["reply_markup"].(map[string]any); ok {
			s.ForceReply, _ = mk["force_reply"].(bool)
			rows, _ := mk["inline_keyboard"].([]any)
			for _, row := range rows {
				btns, _ := row.([]any)
				for _, bt := range btns {
					m, _ := bt.(map[string]any)
					if u := str(m["url"]); u != "" {
						if refuseURL {
							w.WriteHeader(http.StatusBadRequest)
							_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": 400, "description": "Bad Request: wrong HTTP URL"})
							return
						}
						s.Buttons = append(s.Buttons, "url:"+u)
						continue
					}
					s.Buttons = append(s.Buttons, str(m["callback_data"]))
				}
			}
		}
		if method == "sendMessage" {
			s.ReplyTo = int64(num(in["reply_to_message_id"]))
		} else {
			s.ReplyTo = int64(num(in["message_id"]))
		}
		if rs, ok := in["reaction"].([]any); ok && len(rs) > 0 {
			m, _ := rs[0].(map[string]any)
			s.Emoji = str(m["emoji"])
		}
		b.mu.Lock()
		if method == "sendMessage" {
			b.nextMsg++
			s.MessageID = b.nextMsg
		}
		b.sent = append(b.sent, s)
		b.mu.Unlock()
		if method == "sendMessage" {
			ok200(w, telegram.Message{MessageID: s.MessageID, Text: s.Text})
			return
		}
		ok200(w, true)
	case "answerCallbackQuery":
		b.mu.Lock()
		b.answers = append(b.answers, str(in["text"]))
		b.mu.Unlock()
		ok200(w, true)
	case "setMyCommands":
		ok200(w, true)
	default:
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": 404, "description": "Not Found: method not found"})
	}
}

// download serves a file's bytes at /file/bot<token>/<file_path>, as
// Telegram's file server does.
func (b *Bot) download(w http.ResponseWriter, rest string) {
	tok, path, _ := strings.Cut(rest, "/")
	if tok != b.Token {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	b.mu.Lock()
	b.calls = append(b.calls, "file")
	var data []byte
	found := false
	for _, f := range b.files {
		if f.path == path {
			data, found = f.data, true
			break
		}
	}
	b.mu.Unlock()
	if !found {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	_, _ = w.Write(data)
}

// photo takes a sendPhoto upload as Telegram does: multipart, chat_id,
// caption and the file in `photo`.
func (b *Bot) photo(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(20 << 20); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": 400, "description": "Bad Request: not multipart"})
		return
	}
	f, _, err := r.FormFile("photo")
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": 400, "description": "Bad Request: there is no photo in the request"})
		return
	}
	raw, _ := io.ReadAll(f)
	_ = f.Close()
	s := Sent{Method: "sendPhoto", ChatID: r.FormValue("chat_id"), Text: r.FormValue("caption"), Photo: raw, At: time.Now()}
	b.mu.Lock()
	b.calls = append(b.calls, "sendPhoto")
	b.nextMsg++
	s.MessageID = b.nextMsg
	b.sent = append(b.sent, s)
	b.mu.Unlock()
	ok200(w, telegram.Message{MessageID: s.MessageID})
}

// poll confirms updates below offset and returns the rest, holding the
// request for a moment when there are none, as a long poll does.
func (b *Bot) poll(r *http.Request, in map[string]any) []telegram.Update {
	offset := int64(num(in["offset"]))
	wait := time.Duration(num(in["timeout"])) * time.Second
	if wait > b.pollWait {
		wait = b.pollWait
	}
	deadline := time.Now().Add(wait)
	for {
		b.mu.Lock()
		kept := b.updates[:0]
		for _, u := range b.updates {
			if u.UpdateID >= offset {
				kept = append(kept, u)
			}
		}
		b.updates = kept
		out := append([]telegram.Update(nil), kept...)
		b.mu.Unlock()
		left := time.Until(deadline)
		if len(out) > 0 || left <= 0 {
			if out == nil {
				out = []telegram.Update{}
			}
			return out
		}
		select {
		case <-b.notify:
		case <-time.After(left):
		case <-r.Context().Done():
			return []telegram.Update{}
		}
	}
}

func ok200(w http.ResponseWriter, result any) {
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": result})
}

func str(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatInt(int64(t), 10)
	}
	return ""
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}
