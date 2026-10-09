// Package telegramtest is a stand-in for the Telegram Bot API, for tests and
// preview stands: nothing in the suite ever talks to api.telegram.org.
package telegramtest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/telegram"
)

// Sent is one message the fake received for delivery.
type Sent struct {
	Method    string
	ChatID    string
	Text      string
	ParseMode string
	MessageID int64
}

// Bot is a fake Bot API serving one bot.
type Bot struct {
	Token    string
	Username string

	mu       sync.Mutex
	updates  []telegram.Update
	nextID   int64
	nextMsg  int64
	sent     []Sent
	calls    []string
	limit    int // the next limit calls answer 429
	retry    int // their retry_after
	notify   chan struct{}
	pollWait time.Duration
	srv      *httptest.Server
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

// Say queues a text message from a chat, as if someone typed it to the bot.
func (b *Bot) Say(chatID int64, firstName, text string) {
	b.mu.Lock()
	b.nextID++
	b.updates = append(b.updates, telegram.Update{UpdateID: b.nextID, Message: &telegram.Message{
		MessageID: b.nextID, Date: time.Now().Unix(), Text: text,
		From: &telegram.User{ID: chatID, FirstName: firstName},
		Chat: telegram.Chat{ID: chatID, Type: "private", FirstName: firstName},
	}})
	b.mu.Unlock()
	select {
	case b.notify <- struct{}{}:
	default:
	}
}

// Sent returns every message delivered so far.
func (b *Bot) Sent() []Sent {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]Sent(nil), b.sent...)
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
	w.Header().Set("Content-Type", "application/json")
	rest, ok := strings.CutPrefix(r.URL.Path, "/bot")
	tok, method, _ := strings.Cut(rest, "/")
	if !ok || tok != b.Token {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": 401, "description": "Unauthorized"})
		return
	}
	var in map[string]any
	_ = json.NewDecoder(r.Body).Decode(&in)

	b.mu.Lock()
	b.calls = append(b.calls, method)
	if b.limit > 0 {
		b.limit--
		retry := b.retry
		b.mu.Unlock()
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": 429,
			"description": "Too Many Requests: retry after " + itoa(retry), "parameters": map[string]any{"retry_after": retry}})
		return
	}
	b.mu.Unlock()

	switch method {
	case "getMe":
		ok200(w, telegram.User{ID: 42, IsBot: true, FirstName: "Caprock", Username: b.Username})
	case "getUpdates":
		ok200(w, b.poll(r, in))
	case "sendMessage", "editMessageText":
		b.mu.Lock()
		s := Sent{Method: method, ChatID: str(in["chat_id"]), Text: str(in["text"]), ParseMode: str(in["parse_mode"])}
		if method == "sendMessage" {
			b.nextMsg++
			s.MessageID = b.nextMsg
		}
		b.sent = append(b.sent, s)
		b.mu.Unlock()
		ok200(w, telegram.Message{MessageID: s.MessageID, Text: s.Text})
	case "answerCallbackQuery":
		ok200(w, true)
	default:
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": 404, "description": "Not Found: method not found"})
	}
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
		return itoa(int(t))
	}
	return ""
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
