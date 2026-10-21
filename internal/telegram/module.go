package telegram

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Messages from private modules (ADR-076, amended 2026-10-22): a module on
// this machine sends a message to the owner's own paired chat through the
// bot the bridge already runs — there is one reader of getUpdates per bot,
// so a module never gets a bot of its own. A button pressed under such a
// message, or a text reply to it, is written into that module's store
// (collection "telegram") rather than read as a command or a session reply.

const (
	// ModuleCollection is the module-store collection answers land in.
	ModuleCollection = "telegram"
	// ModuleTextMax bounds a module message's own text, in characters; the
	// header and Telegram's limit leave room above it.
	ModuleTextMax = 3500
	// moduleButtonsMax bounds the buttons under one message.
	moduleButtonsMax = 12
	// moduleLabelMax bounds a button's label, in characters.
	moduleLabelMax = 64
	// moduleWaitFor is how long the bridge keeps reading updates for a
	// module message that can be answered, with no alert or two-way chat on.
	moduleWaitFor = 24 * time.Hour
	// moduleData prefixes a module button's callback data.
	moduleData = "x:"
)

// moduleButtonID is a button id: short enough for Telegram's 64-byte
// callback data with the prefix, and plain enough for a document.
var moduleButtonID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,48}$`)

// ModuleButton is one button a module puts under its message.
type ModuleButton struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// ModuleMessage is what a module asks to send.
type ModuleMessage struct {
	// Module is the module's id; Name what the first line calls it.
	Module, Name string
	Text         string
	Buttons      []ModuleButton
	// Reply opens the reply field under the message (when it has no
	// buttons; Telegram takes one or the other). A swipe-reply to any
	// module message is the module's either way.
	Reply bool
}

// ErrMuted is a module message refused because the chat is silenced with
// /mute all.
var ErrMuted = errors.New("telegram: muted with /mute all; send /unmute in the chat")

// ErrModuleMessage is a module message that is not one: no text, too long,
// or a bad button. Wrapped with what is wrong.
var ErrModuleMessage = errors.New("telegram: not a module message")

// Check reports what is wrong with a module message, nil when nothing is.
func (m ModuleMessage) Check() error {
	bad := func(format string, a ...any) error {
		return fmt.Errorf("%w: %s", ErrModuleMessage, fmt.Sprintf(format, a...))
	}
	text := strings.TrimSpace(m.Text)
	if text == "" {
		return bad("text is required")
	}
	if utf8.RuneCountInString(text) > ModuleTextMax {
		return bad("text is at most %d characters", ModuleTextMax)
	}
	if len(m.Buttons) > moduleButtonsMax {
		return bad("at most %d buttons", moduleButtonsMax)
	}
	seen := map[string]bool{}
	for _, b := range m.Buttons {
		if !moduleButtonID.MatchString(b.ID) {
			return bad("a button id is 1 to 48 letters, digits, '.', '_' or '-'")
		}
		if seen[b.ID] {
			return bad("button id %q is used twice", b.ID)
		}
		seen[b.ID] = true
		if l := strings.TrimSpace(b.Label); l == "" || utf8.RuneCountInString(l) > moduleLabelMax {
			return bad("a button label is 1 to %d characters", moduleLabelMax)
		}
	}
	return nil
}

// ModuleText is the message as Telegram gets it, in HTML: the module's name
// on the first line, then its text, escaped.
func ModuleText(name, text string) string {
	return "🧩 <b>" + Escape(name) + "</b>\n" + Escape(strings.TrimSpace(text))
}

// SendModule sends a module's message to the paired chat and returns its
// Telegram message id. ErrNotPaired without a bot and a chat, ErrMuted under
// /mute all.
func (b *Bridge) SendModule(ctx context.Context, m ModuleMessage) (int64, error) {
	if err := m.Check(); err != nil {
		return 0, err
	}
	token, chat := b.Host.Bot()
	if token == "" || chat == "" {
		return 0, ErrNotPaired
	}
	if b.Store.Get().MuteAll {
		return 0, ErrMuted
	}
	name := strings.TrimSpace(m.Name)
	if name == "" {
		name = m.Module
	}
	out := Out{Text: ModuleText(name, m.Text), ParseMode: "HTML"}
	ref := Ref{Module: m.Module, Kind: "module"}
	if len(m.Buttons) > 0 {
		mk := &Markup{}
		ref.Buttons = map[string]string{}
		for _, bt := range m.Buttons {
			label := strings.TrimSpace(bt.Label)
			mk.InlineKeyboard = append(mk.InlineKeyboard, []InlineButton{{Text: label, CallbackData: moduleData + bt.ID}})
			ref.Buttons[bt.ID] = label
		}
		out.Markup = mk
	} else if m.Reply {
		out.ForceReply = &ForceReply{ForceReply: true, Placeholder: clipRunes("Reply to "+name, 64)}
	}
	// Remembered before Send returns, so an answer read at once finds it.
	out.Sent = func(msg Message, err error) {
		if err == nil {
			ref.MessageID = msg.MessageID
			ref.At = b.now().UnixMilli()
			b.Store.Remember(ref)
		}
	}
	msg, err := b.Out.Send(ctx, out)
	if err != nil {
		return 0, err
	}
	if len(m.Buttons) > 0 || m.Reply {
		// Something may answer it: read updates even with no alert on.
		b.Wake()
	}
	return msg.MessageID, nil
}

// moduleWaiting reports a module message sent in the last day that can be
// answered: the bridge reads updates for it.
func (b *Bridge) moduleWaiting() bool {
	now := b.now()
	refs := b.Store.Get().Refs
	for i := len(refs) - 1; i >= 0; i-- {
		r := refs[i]
		if r.Module != "" && now.Sub(time.UnixMilli(r.At)) < moduleWaitFor {
			return true
		}
	}
	return false
}

// moduleAnswer writes one answer to a module message into the module's
// store, as telegram/<message_id>-<n>, n counting that message's answers.
func (b *Bridge) moduleAnswer(ctx context.Context, ref Ref, doc map[string]any) error {
	if b.ModuleAnswer == nil {
		return errors.New("module answers are not kept here")
	}
	n := b.Store.NextAnswer(ref.MessageID)
	doc["at"] = b.now().UnixMilli()
	id := strconv.FormatInt(ref.MessageID, 10) + "-" + strconv.Itoa(n)
	return b.ModuleAnswer(ctx, ref.Module, id, doc)
}

// modulePress is a button under a module message.
func (b *Bridge) modulePress(ctx context.Context, c *Client, chat string, msgID int64, ref Ref, id string, toast func(string)) {
	if ref.Module == "" {
		toast("I no longer know which module this was.")
		return
	}
	label, ok := ref.Buttons[id]
	if !ok {
		toast("That button is out of date.")
		return
	}
	if err := b.moduleAnswer(ctx, ref, map[string]any{"button": id}); err != nil {
		b.Log.Warn("telegram: a module answer was not kept", "component", "telegram", "module", ref.Module, "err", err)
		toast(clipToast("Not saved: " + err.Error()))
		return
	}
	toast("")
	_ = c.EditMarkup(ctx, chat, msgID, &Markup{InlineKeyboard: [][]InlineButton{{{Text: "✓ " + label, CallbackData: "-"}}}})
}

// moduleReply is a text reply to a module message.
func (b *Bridge) moduleReply(ctx context.Context, m *Message, ref Ref, text string) {
	if text == "" {
		return
	}
	if err := b.moduleAnswer(ctx, ref, map[string]any{"text": text}); err != nil {
		b.Log.Warn("telegram: a module answer was not kept", "component", "telegram", "module", ref.Module, "err", err)
		b.say(m, "Not saved: "+err.Error())
		return
	}
	token, chat := b.Host.Bot()
	if err := b.client(token).React(ctx, chat, m.MessageID, "👍"); err != nil {
		b.Log.Info("telegram: could not mark a module reply as kept", "component", "telegram", "err", err)
	}
}
