// Package telegram is Caprock's client for the Telegram Bot API, used with a
// bot the user created themselves (ADR-045).
//
// It speaks plain HTTPS to one documented host and nothing else: getMe to
// check a token, getUpdates (long polling, so nothing listens for inbound
// connections) to hear the pairing code, sendMessage, editMessageText and
// answerCallbackQuery. No webhook, no relay of ours.
//
// The token is in every request URL, so it is in every transport error's
// text. Nothing this package returns carries it: errors are scrubbed before
// they leave, because they are logged and shown on the Settings screen.
package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"strings"
	"time"
)

// DefaultBase is the only host this package contacts unless a test or a
// preview stand points it at a stand-in.
const DefaultBase = "https://api.telegram.org"

// sendTimeout bounds every call except a long poll.
const sendTimeout = 20 * time.Second

// maxRetryWait is the longest a call waits on a 429 before giving up: Telegram
// says how long to wait, and an alert that arrives a few seconds late is still
// an alert, while one held for a minute is a stale one.
const maxRetryWait = 10 * time.Second

// Client calls the Bot API as one bot. The zero value with a Token is usable.
type Client struct {
	Token string
	// Base overrides DefaultBase (tests, preview stands).
	Base string
	// HTTP is the transport; nil uses one with no overall timeout, because
	// each call sets its own deadline (a long poll outlives a send).
	HTTP *http.Client
	// MaxRetryWait overrides maxRetryWait; 0 keeps it, negative never waits.
	MaxRetryWait time.Duration
}

// APIError is Telegram refusing a call, in its own words: "Unauthorized",
// "chat not found", "bot was blocked by the user" are all things only the
// user can fix, and worth reading verbatim.
type APIError struct {
	Code        int
	Description string
	// RetryAfter is set on a 429: how long Telegram asked us to wait.
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	if e.Description != "" {
		return "telegram: " + e.Description
	}
	return fmt.Sprintf("telegram: http %d", e.Code)
}

// Unauthorized reports whether err is Telegram refusing the token itself.
func Unauthorized(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && (ae.Code == http.StatusUnauthorized || ae.Code == http.StatusNotFound)
}

// ErrNoToken is a call made with no token at all.
var ErrNoToken = errors.New("telegram: no bot token")

func (c *Client) base() string {
	if c.Base != "" {
		return strings.TrimRight(c.Base, "/")
	}
	return DefaultBase
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{}
}

func (c *Client) retryWait() time.Duration {
	if c.MaxRetryWait != 0 {
		return c.MaxRetryWait
	}
	return maxRetryWait
}

// Call invokes one Bot API method with params as its JSON body and decodes
// the result into out (which may be nil). A 429 is waited out and retried
// while Telegram's retry_after fits in the client's limit and ctx allows it.
func (c *Client) Call(ctx context.Context, method string, params, out any) error {
	for attempt := 0; ; attempt++ {
		err := c.call(ctx, method, params, out, sendTimeout)
		var ae *APIError
		if !errors.As(err, &ae) || ae.Code != http.StatusTooManyRequests || attempt >= 2 {
			return err
		}
		wait := ae.RetryAfter
		if wait <= 0 {
			wait = time.Second
		}
		if wait > c.retryWait() {
			return err
		}
		if !sleep(ctx, wait) {
			return err
		}
	}
}

// call is one request with its own deadline.
func (c *Client) call(ctx context.Context, method string, params, out any, timeout time.Duration) error {
	if strings.TrimSpace(c.Token) == "" {
		return ErrNoToken
	}
	if params == nil {
		params = struct{}{}
	}
	body, err := json.Marshal(params)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	url := c.base() + "/bot" + c.Token + "/" + method
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return c.scrub(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "caprock")

	res, err := c.http().Do(req)
	if err != nil {
		return c.scrub(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	var env struct {
		OK          bool            `json:"ok"`
		Result      json.RawMessage `json:"result"`
		ErrorCode   int             `json:"error_code"`
		Description string          `json:"description"`
		Parameters  struct {
			RetryAfter int `json:"retry_after"`
		} `json:"parameters"`
	}
	if err := json.Unmarshal(raw, &env); err != nil || !env.OK {
		code := env.ErrorCode
		if code == 0 {
			code = res.StatusCode
		}
		return &APIError{
			Code:        code,
			Description: strings.ReplaceAll(env.Description, c.Token, "<token>"),
			RetryAfter:  time.Duration(env.Parameters.RetryAfter) * time.Second,
		}
	}
	if out != nil && len(env.Result) > 0 {
		if err := json.Unmarshal(env.Result, out); err != nil {
			return fmt.Errorf("telegram: %s: unexpected result", method)
		}
	}
	return nil
}

// scrub drops the URL from a transport error (it carries the token) and
// replaces the token anywhere else it might appear.
func (c *Client) scrub(err error) error {
	var ue *neturl.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	msg := err.Error()
	if c.Token != "" {
		msg = strings.ReplaceAll(msg, c.Token, "<token>")
	}
	return errors.New("telegram: " + msg)
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// User is a Telegram account; for getMe, the bot itself.
type User struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name,omitempty"`
	Username  string `json:"username,omitempty"`
}

// Chat is where a message was sent.
type Chat struct {
	ID        int64  `json:"id"`
	Type      string `json:"type"` // private, group, supergroup, channel
	Title     string `json:"title,omitempty"`
	Username  string `json:"username,omitempty"`
	FirstName string `json:"first_name,omitempty"`
	LastName  string `json:"last_name,omitempty"`
}

// Name is how a chat reads on the Settings screen: a group's title, or a
// person's name.
func (c Chat) Name() string {
	if c.Title != "" {
		return c.Title
	}
	n := strings.TrimSpace(c.FirstName + " " + c.LastName)
	if n == "" && c.Username != "" {
		n = "@" + c.Username
	}
	return n
}

// Message is a received or sent message.
type Message struct {
	MessageID int64  `json:"message_id"`
	From      *User  `json:"from,omitempty"`
	Chat      Chat   `json:"chat"`
	Date      int64  `json:"date"`
	Text      string `json:"text,omitempty"`
}

// CallbackQuery is a press of an inline button (phase 2).
type CallbackQuery struct {
	ID      string   `json:"id"`
	From    User     `json:"from"`
	Message *Message `json:"message,omitempty"`
	Data    string   `json:"data,omitempty"`
}

// Update is one item from getUpdates.
type Update struct {
	UpdateID      int64          `json:"update_id"`
	Message       *Message       `json:"message,omitempty"`
	CallbackQuery *CallbackQuery `json:"callback_query,omitempty"`
}

// InlineButton is one button under a message (phase 2: answers).
type InlineButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data,omitempty"`
}

// Markup is an inline keyboard: rows of buttons.
type Markup struct {
	InlineKeyboard [][]InlineButton `json:"inline_keyboard"`
}

// GetMe returns the bot the token belongs to — the check that a pasted token
// is real.
func (c *Client) GetMe(ctx context.Context) (User, error) {
	var u User
	err := c.Call(ctx, "getMe", nil, &u)
	return u, err
}

// Send is a message to send. ParseMode "HTML" means the caller escaped Text.
type Send struct {
	ChatID    string  `json:"chat_id"`
	Text      string  `json:"text"`
	ParseMode string  `json:"parse_mode,omitempty"`
	Markup    *Markup `json:"reply_markup,omitempty"`
	// Previews are always off: a session link or a URL in a command must not
	// make Telegram fetch it.
	DisablePreview bool `json:"disable_web_page_preview"`
}

// SendMessage posts one message and returns it (its id is what an edit needs).
func (c *Client) SendMessage(ctx context.Context, s Send) (Message, error) {
	if strings.TrimSpace(s.ChatID) == "" {
		return Message{}, errors.New("telegram: no chat")
	}
	s.DisablePreview = true
	var m Message
	err := c.Call(ctx, "sendMessage", s, &m)
	return m, err
}

// EditMessageText replaces a sent message's text and buttons — how a phase 2
// answer marks the question as answered.
func (c *Client) EditMessageText(ctx context.Context, chatID string, messageID int64, text, parseMode string, markup *Markup) error {
	params := map[string]any{
		"chat_id": chatID, "message_id": messageID, "text": text,
		"disable_web_page_preview": true,
	}
	if parseMode != "" {
		params["parse_mode"] = parseMode
	}
	if markup != nil {
		params["reply_markup"] = markup
	}
	return c.Call(ctx, "editMessageText", params, nil)
}

// AnswerCallbackQuery stops a pressed button's spinner, with an optional toast.
func (c *Client) AnswerCallbackQuery(ctx context.Context, id, text string) error {
	return c.Call(ctx, "answerCallbackQuery", map[string]any{"callback_query_id": id, "text": text}, nil)
}

// GetUpdates long-polls for up to wait (whole seconds) for updates after
// offset-1. Updates below offset are confirmed and never returned again.
func (c *Client) GetUpdates(ctx context.Context, offset int64, wait time.Duration) ([]Update, error) {
	var out []Update
	err := c.call(ctx, "getUpdates", map[string]any{
		"offset": offset, "timeout": int(wait / time.Second),
		"allowed_updates": []string{"message", "callback_query"},
	}, &out, wait+sendTimeout)
	return out, err
}

// MaskToken is how a token is ever shown: "••••••" and its last four
// characters, enough to tell two bots apart and useless to anyone else.
func MaskToken(token string) string {
	token = strings.TrimSpace(token)
	if token == "" {
		return ""
	}
	r := []rune(token)
	if len(r) <= 8 {
		return "••••••"
	}
	return "••••••" + string(r[len(r)-4:])
}
