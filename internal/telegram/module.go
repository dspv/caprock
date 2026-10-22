package telegram

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
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
	// ReplyTo threads the message under one this module sent; 0 is none.
	// Any other message is ErrNotModuleMessage.
	ReplyTo int64
}

// ModuleEdit is what a module asks to change in a message it sent. Nil
// leaves a part as it is; a non-nil empty Buttons removes them all.
type ModuleEdit struct {
	// Module is the module's id; Name what the first line calls it.
	Module, Name string
	MessageID    int64
	Text         *string
	Buttons      *[]ModuleButton
}

// ErrNotModuleMessage is a message id that is not one this module sent: an
// unknown one, another module's, the bridge's own, or one sent so long ago
// that the bridge no longer remembers it.
var ErrNotModuleMessage = errors.New("telegram: not a message this module sent")

// ErrMuted is a module message refused because the chat is silenced with
// /mute all.
var ErrMuted = errors.New("telegram: muted with /mute all; send /unmute in the chat")

// ErrModuleMessage is a module message that is not one: no text, too long,
// or a bad button. Wrapped with what is wrong.
var ErrModuleMessage = errors.New("telegram: not a module message")

func badModule(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrModuleMessage, fmt.Sprintf(format, a...))
}

// Check reports what is wrong with a module message, nil when nothing is.
func (m ModuleMessage) Check() error {
	if err := checkModuleText(m.Text); err != nil {
		return err
	}
	if m.ReplyTo < 0 {
		return badModule("reply_to_message_id is a message id")
	}
	return checkModuleButtons(m.Buttons)
}

// Check reports what is wrong with a module's edit, nil when nothing is:
// the same limits as a message, and at least one part to change.
func (e ModuleEdit) Check() error {
	if e.Text == nil && e.Buttons == nil {
		return badModule("text or buttons is required")
	}
	if e.Text != nil {
		if err := checkModuleText(*e.Text); err != nil {
			return err
		}
	}
	if e.Buttons != nil {
		return checkModuleButtons(*e.Buttons)
	}
	return nil
}

func checkModuleText(t string) error {
	text := strings.TrimSpace(t)
	if text == "" {
		return badModule("text is required")
	}
	if utf8.RuneCountInString(text) > ModuleTextMax {
		return badModule("text is at most %d characters", ModuleTextMax)
	}
	return nil
}

func checkModuleButtons(buttons []ModuleButton) error {
	if len(buttons) > moduleButtonsMax {
		return badModule("at most %d buttons", moduleButtonsMax)
	}
	seen := map[string]bool{}
	for _, b := range buttons {
		if !moduleButtonID.MatchString(b.ID) {
			return badModule("a button id is 1 to 48 letters, digits, '.', '_' or '-'")
		}
		if seen[b.ID] {
			return badModule("button id %q is used twice", b.ID)
		}
		seen[b.ID] = true
		if l := strings.TrimSpace(b.Label); l == "" || utf8.RuneCountInString(l) > moduleLabelMax {
			return badModule("a button label is 1 to %d characters", moduleLabelMax)
		}
	}
	return nil
}

// moduleKeyboard is a module's buttons as Telegram takes them, one per row,
// with their labels by id and their order; nil markup for none.
func moduleKeyboard(buttons []ModuleButton) (*Markup, map[string]string, []string) {
	if len(buttons) == 0 {
		return nil, nil, nil
	}
	mk := &Markup{}
	labels := map[string]string{}
	order := make([]string, 0, len(buttons))
	for _, bt := range buttons {
		label := strings.TrimSpace(bt.Label)
		mk.InlineKeyboard = append(mk.InlineKeyboard, []InlineButton{{Text: label, CallbackData: moduleData + bt.ID}})
		labels[bt.ID] = label
		order = append(order, bt.ID)
	}
	return mk, labels, order
}

// chosenKeyboard is what a module message shows once a button was pressed.
func chosenKeyboard(label string) *Markup {
	return &Markup{InlineKeyboard: [][]InlineButton{{{Text: "✓ " + label, CallbackData: "-"}}}}
}

// shownKeyboard is the keyboard a module message shows now, rebuilt from
// what the bridge remembers, so an edit of its text alone keeps it.
func shownKeyboard(ref Ref) *Markup {
	if ref.Chosen != "" {
		if label, ok := ref.Buttons[ref.Chosen]; ok {
			return chosenKeyboard(label)
		}
	}
	order := ref.Order
	if len(order) != len(ref.Buttons) {
		// A message remembered without its order: by id.
		order = make([]string, 0, len(ref.Buttons))
		for id := range ref.Buttons {
			order = append(order, id)
		}
		sort.Strings(order)
	}
	buttons := make([]ModuleButton, 0, len(order))
	for _, id := range order {
		if label, ok := ref.Buttons[id]; ok {
			buttons = append(buttons, ModuleButton{ID: id, Label: label})
		}
	}
	mk, _, _ := moduleKeyboard(buttons)
	return mk
}

// moduleRef is the remembered message messageID when module sent it.
func (b *Bridge) moduleRef(module string, messageID int64) (Ref, bool) {
	if messageID <= 0 || module == "" {
		return Ref{}, false
	}
	ref, ok := b.Store.Lookup(messageID)
	if !ok || ref.Kind != "module" || ref.Module != module {
		return Ref{}, false
	}
	return ref, true
}

// notModified is Telegram refusing an edit that changes nothing: for a
// module asking for what the message already shows, that is done.
func notModified(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Code == http.StatusBadRequest &&
		strings.Contains(strings.ToLower(ae.Description), "message is not modified")
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
	if m.ReplyTo != 0 {
		if _, ok := b.moduleRef(m.Module, m.ReplyTo); !ok {
			return 0, ErrNotModuleMessage
		}
	}
	name := moduleName(m.Name, m.Module)
	out := Out{Text: ModuleText(name, m.Text), ParseMode: "HTML", ReplyTo: m.ReplyTo}
	ref := Ref{Module: m.Module, Kind: "module"}
	if len(m.Buttons) > 0 {
		out.Markup, ref.Buttons, ref.Order = moduleKeyboard(m.Buttons)
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

func moduleName(name, module string) string {
	if n := strings.TrimSpace(name); n != "" {
		return n
	}
	return module
}

// EditModule changes the text, the buttons or both of a message the module
// sent: editMessageText for new text (keeping the buttons it shows unless
// new ones are given), editMessageReplyMarkup for buttons alone. A press on
// new buttons is written to the module's store as one on the first ones.
// Telegram's "message is not modified" is success. ErrModuleMessage for a
// bad edit, ErrNotModuleMessage for a message the module did not send,
// ErrNotPaired without a bot and a chat. /mute all does not hold an edit
// back: it changes a message already in the chat and makes no sound.
func (b *Bridge) EditModule(ctx context.Context, e ModuleEdit) error {
	if err := e.Check(); err != nil {
		return err
	}
	ref, ok := b.moduleRef(e.Module, e.MessageID)
	if !ok {
		return ErrNotModuleMessage
	}
	token, chat := b.Host.Bot()
	if token == "" || chat == "" {
		return ErrNotPaired
	}
	var (
		mk     *Markup
		labels map[string]string
		order  []string
	)
	if e.Buttons != nil {
		mk, labels, order = moduleKeyboard(*e.Buttons)
	} else {
		mk = shownKeyboard(ref)
	}
	c := b.client(token)
	var err error
	if e.Text != nil {
		err = c.EditText(ctx, chat, e.MessageID, clipText(ModuleText(moduleName(e.Name, e.Module), *e.Text)), "HTML", mk)
	} else {
		err = c.EditMarkup(ctx, chat, e.MessageID, mk)
	}
	if err != nil && !notModified(err) {
		return err
	}
	if e.Buttons != nil {
		b.Store.UpdateRef(e.MessageID, func(r *Ref) {
			r.Buttons, r.Order, r.Chosen = labels, order, ""
			if len(labels) > 0 {
				// New buttons can be pressed: read updates for another day.
				r.At = b.now().UnixMilli()
			}
		})
		if len(labels) > 0 {
			b.Wake()
		}
	}
	return nil
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
	b.Store.UpdateRef(msgID, func(r *Ref) { r.Chosen = id })
	_ = c.EditMarkup(ctx, chat, msgID, chosenKeyboard(label))
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
