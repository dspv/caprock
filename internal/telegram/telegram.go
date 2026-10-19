// Package telegram is Caprock's client for the Telegram Bot API, used with a
// bot the user created themselves (ADR-047), and the bridge that lets the
// owner talk to their sessions through it.
//
// It speaks plain HTTPS to one documented host and nothing else: getMe to
// check a token, getUpdates (long polling, so nothing listens for inbound
// connections) to hear the pairing code, replies and button presses,
// sendMessage, sendPhoto (a share card, only on the user's click),
// editMessageReplyMarkup, editMessageText, setMessageReaction,
// setMyCommands and answerCallbackQuery, and getFile with its download for
// a photo, file or voice note forwarded to the bot (ADR-081). No webhook,
// no relay of ours.
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
	"mime/multipart"
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
	return c.retrying(ctx, func() error { return c.call(ctx, method, params, out, sendTimeout) })
}

// retrying runs one request, waiting out a 429 as Call describes.
func (c *Client) retrying(ctx context.Context, do func() error) error {
	for attempt := 0; ; attempt++ {
		err := do()
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
	return c.post(ctx, method, "application/json", body, out, timeout)
}

// post sends one request body of the given type and decodes Telegram's
// envelope; call (JSON) and SendPhoto (multipart) share it.
func (c *Client) post(ctx context.Context, method, contentType string, body []byte, out any, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	url := c.base() + "/bot" + c.Token + "/" + method
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return c.scrub(err)
	}
	req.Header.Set("Content-Type", contentType)
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
	// ReplyTo is the message this one answers, when the sender used
	// Telegram's Reply: how a reply finds its session.
	ReplyTo *Message `json:"reply_to_message,omitempty"`

	// What a forwarded or shared message carries (ADR-081): who wrote it
	// first, the caption under a photo or file, the album it belongs to,
	// and its photo (every size, smallest first), file, voice note, audio or
	// video.
	ForwardOrigin *ForwardOrigin `json:"forward_origin,omitempty"`
	Caption       string         `json:"caption,omitempty"`
	MediaGroupID  string         `json:"media_group_id,omitempty"`
	Photo         []PhotoSize    `json:"photo,omitempty"`
	Document      *FileRef       `json:"document,omitempty"`
	Voice         *FileRef       `json:"voice,omitempty"`
	Audio         *FileRef       `json:"audio,omitempty"`
	Video         *FileRef       `json:"video,omitempty"`
}

// ForwardOrigin is where a forwarded message came from: a person
// ("user", or "hidden_user" when they hide their account), a chat or a
// channel.
type ForwardOrigin struct {
	Type           string `json:"type"`
	Date           int64  `json:"date,omitempty"`
	SenderUser     *User  `json:"sender_user,omitempty"`
	SenderUserName string `json:"sender_user_name,omitempty"`
	SenderChat     *Chat  `json:"sender_chat,omitempty"`
	Chat           *Chat  `json:"chat,omitempty"`
}

// Name is the forwarded message's author as Telegram tells it, or "".
func (o *ForwardOrigin) Name() string {
	if o == nil {
		return ""
	}
	switch {
	case o.SenderUser != nil:
		n := strings.TrimSpace(o.SenderUser.FirstName + " " + o.SenderUser.LastName)
		if n == "" && o.SenderUser.Username != "" {
			n = "@" + o.SenderUser.Username
		}
		return n
	case o.SenderUserName != "":
		return o.SenderUserName
	case o.SenderChat != nil:
		return o.SenderChat.Name()
	case o.Chat != nil:
		return o.Chat.Name()
	}
	return ""
}

// PhotoSize is one size of a photo; a message carries several.
type PhotoSize struct {
	FileID   string `json:"file_id"`
	Width    int    `json:"width,omitempty"`
	Height   int    `json:"height,omitempty"`
	FileSize int64  `json:"file_size,omitempty"`
}

// FileRef is a document, voice note, audio or video in a message: what
// getFile needs to fetch it, and what it says about itself.
type FileRef struct {
	FileID   string `json:"file_id"`
	FileName string `json:"file_name,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
	FileSize int64  `json:"file_size,omitempty"`
	Duration int    `json:"duration,omitempty"`
}

// CallbackQuery is a press of an inline button.
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

// InlineButton is one button under a message: a callback the bridge
// answers, or a URL Telegram opens.
type InlineButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data,omitempty"`
	URL          string `json:"url,omitempty"`
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

// ForceReply opens the reply field on the reader's phone under the message,
// so answering a session is one tap.
type ForceReply struct {
	ForceReply  bool   `json:"force_reply"`
	Placeholder string `json:"input_field_placeholder,omitempty"`
}

// Send is a message to send. ParseMode "HTML" means the caller escaped Text.
type Send struct {
	ChatID    string `json:"chat_id"`
	Text      string `json:"text"`
	ParseMode string `json:"parse_mode,omitempty"`
	// Markup is the buttons under the message; ForceReply, when Markup is
	// nil, asks for a reply instead. Telegram takes one or the other.
	Markup      *Markup     `json:"-"`
	ForceReply  *ForceReply `json:"-"`
	ReplyMarkup any         `json:"reply_markup,omitempty"`
	// ReplyTo threads a message under the one it answers.
	ReplyTo int64 `json:"reply_to_message_id,omitempty"`
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
	switch {
	case s.Markup != nil:
		s.ReplyMarkup = s.Markup
	case s.ForceReply != nil:
		s.ReplyMarkup = s.ForceReply
	}
	var m Message
	err := c.Call(ctx, "sendMessage", s, &m)
	return m, err
}

// EditMarkup replaces a sent message's buttons — how an answered question
// shows it was answered, without resending its text. A nil markup removes
// them all.
func (c *Client) EditMarkup(ctx context.Context, chatID string, messageID int64, markup *Markup) error {
	if markup == nil {
		markup = &Markup{InlineKeyboard: [][]InlineButton{}}
	}
	return c.Call(ctx, "editMessageReplyMarkup", map[string]any{
		"chat_id": chatID, "message_id": messageID, "reply_markup": markup,
	}, nil)
}

// React puts one emoji reaction on a message: how a reply that reached its
// session says so without another message in the chat.
func (c *Client) React(ctx context.Context, chatID string, messageID int64, emoji string) error {
	return c.Call(ctx, "setMessageReaction", map[string]any{
		"chat_id": chatID, "message_id": messageID,
		"reaction": []map[string]string{{"type": "emoji", "emoji": emoji}},
	}, nil)
}

// Command is one entry of the bot's command menu.
type Command struct {
	Command     string `json:"command"`
	Description string `json:"description"`
}

// SetCommands sets the menu Telegram shows under "/" in the bot's chat.
func (c *Client) SetCommands(ctx context.Context, cmds []Command) error {
	return c.Call(ctx, "setMyCommands", map[string]any{"commands": cmds}, nil)
}

// AnswerCallbackQuery stops a pressed button's spinner, with an optional toast.
func (c *Client) AnswerCallbackQuery(ctx context.Context, id, text string) error {
	return c.Call(ctx, "answerCallbackQuery", map[string]any{"callback_query_id": id, "text": text}, nil)
}

// MaxCaption is the longest photo caption Telegram takes, in characters.
const MaxCaption = 1024

// photoTimeout bounds a photo upload: a 2x card is a few hundred kilobytes,
// and a slow uplink should not be cut off at a text message's deadline.
const photoTimeout = 60 * time.Second

// SendPhoto posts one PNG with a plain-text caption to a chat
// (multipart/form-data, as the Bot API takes a file upload). The caption is
// cut to MaxCaption characters rather than refused.
func (c *Client) SendPhoto(ctx context.Context, chatID string, png []byte, caption string) (Message, error) {
	if strings.TrimSpace(c.Token) == "" {
		return Message{}, ErrNoToken
	}
	if strings.TrimSpace(chatID) == "" {
		return Message{}, errors.New("telegram: no chat")
	}
	if r := []rune(caption); len(r) > MaxCaption {
		caption = string(r[:MaxCaption])
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("chat_id", chatID)
	if caption != "" {
		_ = mw.WriteField("caption", caption)
	}
	fw, err := mw.CreateFormFile("photo", "caprock.png")
	if err != nil {
		return Message{}, err
	}
	if _, err := fw.Write(png); err != nil {
		return Message{}, err
	}
	if err := mw.Close(); err != nil {
		return Message{}, err
	}
	var m Message
	err = c.retrying(ctx, func() error {
		return c.post(ctx, "sendPhoto", mw.FormDataContentType(), buf.Bytes(), &m, photoTimeout)
	})
	return m, err
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

// EditText replaces a sent message's text and buttons; a nil markup
// removes the buttons.
func (c *Client) EditText(ctx context.Context, chatID string, messageID int64, text, parseMode string, markup *Markup) error {
	if markup == nil {
		markup = &Markup{InlineKeyboard: [][]InlineButton{}}
	}
	params := map[string]any{
		"chat_id": chatID, "message_id": messageID, "text": text, "reply_markup": markup,
		"disable_web_page_preview": true,
	}
	if parseMode != "" {
		params["parse_mode"] = parseMode
	}
	return c.Call(ctx, "editMessageText", params, nil)
}

// MaxDownload is the largest file the Bot API lets a bot fetch.
const MaxDownload = 20 << 20

// downloadTimeout bounds one file fetch.
const downloadTimeout = 60 * time.Second

// errTooLarge is a file over the limit Download was given.
var errTooLarge = errors.New("telegram: the file is too large to fetch")

// TooLarge reports whether err is Download refusing a file for its size.
func TooLarge(err error) bool { return errors.Is(err, errTooLarge) }

// Download fetches a file someone sent the bot: getFile for its path on
// Telegram's file server, then the bytes, at most limit of them (a larger
// file is refused, not cut). The token is in the file URL too, so errors
// are scrubbed as every other call's are.
func (c *Client) Download(ctx context.Context, fileID string, limit int64) ([]byte, error) {
	var f struct {
		FilePath string `json:"file_path"`
		FileSize int64  `json:"file_size"`
	}
	if err := c.Call(ctx, "getFile", map[string]any{"file_id": fileID}, &f); err != nil {
		return nil, err
	}
	if f.FilePath == "" {
		return nil, errors.New("telegram: the file is not available")
	}
	if f.FileSize > limit {
		return nil, errTooLarge
	}
	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base()+"/file/bot"+c.Token+"/"+f.FilePath, nil)
	if err != nil {
		return nil, c.scrub(err)
	}
	req.Header.Set("User-Agent", "caprock")
	res, err := c.http().Do(req)
	if err != nil {
		return nil, c.scrub(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("telegram: http %d fetching a file", res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, c.scrub(err)
	}
	if int64(len(raw)) > limit {
		return nil, errTooLarge
	}
	return raw, nil
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
