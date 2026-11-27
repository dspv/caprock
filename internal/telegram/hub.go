package telegram

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// One bot for all the owner's computers (ADR-047, amended 2026-11-27).
//
// Telegram lets one process at a time read a bot's updates, so two computers
// cannot each poll the same bot. One computer **holds** the bot: it is set
// up there as before, and it alone talks to Telegram. Every other computer
// that reaches it (ADR-067: it pasted the holder's link and the holder's
// owner allowed it) may **send through** it: its alerts and questions go to
// the holder over their end-to-end encrypted link, the holder posts each
// under a first line naming the computer it came from, and a button press or
// a reply to it goes back to that computer, which acts on it with its own
// rules — rule 7 and the two-way switch are the asking
// computer's, never the holder's.
//
// The direction follows the link. A computer sends through a holder it
// reaches; the holder never calls it. Presses go back because the sender
// asks for them (a long poll while something it sent can still be answered),
// so a holder that cannot reach the sender still serves it.
//
// This file is the holder's half; via.go is the sender's.

// The actions a button on a message from another computer may carry, and a
// reply to it. Anything else is dropped from the message.
const (
	ActApprove = "approve"
	ActDeny    = "deny"
	ActMute    = "mute"
	ActReply   = "reply"
)

// Sender is the computer a hub request came from, as the holder knows it:
// its device id and name in this machine's devices.json, never what the
// request says about itself.
type Sender struct {
	ID   string
	Name string
	// Key is the relay key its token is bound to (pairing.Device.Key),
	// which is its id in this machine's own machines.json if this machine
	// reaches it too.
	Key string
}

// HubButton is one button under a message from another computer: an action
// the holder hands back on a press, or a URL Telegram opens.
type HubButton struct {
	Text   string `json:"text"`
	Action string `json:"action,omitempty"`
	URL    string `json:"url,omitempty"`
}

// HubMessage is one message another computer asks the holder to post.
type HubMessage struct {
	// ID is the sender's own id for it (at most 64 characters): what a press
	// coming back names, and what makes a repeated post a no-op.
	ID string `json:"id"`
	// Text is the message; HTML when ParseMode is "HTML", else plain.
	Text      string `json:"text"`
	ParseMode string `json:"parse_mode,omitempty"`
	// Buttons are rows of buttons under it.
	Buttons [][]HubButton `json:"buttons,omitempty"`
	// Reply says a Telegram reply to it is carried back as ActReply.
	Reply bool `json:"reply,omitempty"`
	// LateS is how many seconds it waited on the sender for the holder;
	// shown when a minute or more.
	LateS int64 `json:"late_s,omitempty"`
}

// HubPress is a button pressed, or a reply sent, under a message from
// another computer, waiting for that computer to take it.
type HubPress struct {
	// ID is the message's id on the sender (HubMessage.ID).
	ID     string `json:"id"`
	Action string `json:"action"`
	// Text is a reply's words.
	Text string `json:"text,omitempty"`
	// Reply is the holder's Telegram message an outcome is threaded under
	// (the reply itself); opaque to the sender, handed back in HubResult.
	Reply int64 `json:"reply,omitempty"`
	At    int64 `json:"at"`
}

// HubResult is what the sender did with a press, for the chat.
type HubResult struct {
	ID string `json:"id"`
	// Label replaces the message's buttons ("✅ Approved from Telegram").
	Label string `json:"label,omitempty"`
	// Say is a line threaded under the reply, or under the message.
	Say string `json:"say,omitempty"`
	// React puts a 👍 on the reply: it reached its session.
	React bool  `json:"react,omitempty"`
	Reply int64 `json:"reply,omitempty"`
}

// HubInfo is whether this machine holds a bot another computer can send
// through.
type HubInfo struct {
	Holder      bool   `json:"holder"`
	BotUsername string `json:"bot_username,omitempty"`
	ChatName    string `json:"chat_name,omitempty"`
}

// Handover is the bot moving to the computer that asked: everything it
// needs to carry on where this machine stops, without a new bot or a new
// pairing. It crosses only the end-to-end encrypted link (ADR-067).
type Handover struct {
	Token       string `json:"token"`
	ChatID      string `json:"chat_id"`
	ChatName    string `json:"chat_name,omitempty"`
	BotID       int64  `json:"bot_id,omitempty"`
	BotUsername string `json:"bot_username,omitempty"`
	Offset      int64  `json:"offset,omitempty"`
}

// ErrNotHolder is a hub request to a machine with no bot and chat of its own.
var ErrNotHolder error = sentence("This computer has no Telegram bot connected, so it cannot carry another computer's messages.")

// errHubUnknown is a result for a message this machine never posted.
var errHubUnknown = errors.New("telegram: no such message from that computer")

// errHubBad is a message the holder will not post.
type errHubBad string

func (e errHubBad) Error() string { return string(e) }

const (
	// hubPressMax bounds the presses waiting for one computer.
	hubPressMax = 100
	// hubWaitFor is how long a message from another computer keeps the
	// bridge reading updates for its buttons and replies.
	hubWaitFor = 24 * time.Hour
	// hubLateShown is the delay from which a message says it is late.
	hubLateShown = 60
	// hubMaxText bounds a message's text before the holder's header.
	hubMaxText = MaxText - 256
)

// hubState is the holder's in-memory half: presses waiting per computer.
type hubState struct {
	presses map[string][]HubPress
	// wake is closed and replaced whenever a press is queued, so every
	// long poll waiting hears it.
	wake chan struct{}
}

// HubInfo says whether this machine holds a bot others can send through.
func (b *Bridge) HubInfo() HubInfo {
	token, chat := b.Host.Bot()
	if token == "" || chat == "" {
		return HubInfo{}
	}
	st := b.Store.Get()
	return HubInfo{Holder: true, BotUsername: st.BotUsername, ChatName: st.ChatName}
}

// HubPost posts another computer's message to the paired chat, under a
// first line naming that computer, and returns its Telegram message id. A
// message already posted under the same id is not posted again: a sender
// that lost the answer asks again.
func (b *Bridge) HubPost(ctx context.Context, s Sender, m HubMessage) (int64, error) {
	token, chat := b.Host.Bot()
	if token == "" || chat == "" {
		return 0, ErrNotHolder
	}
	m.ID = strings.TrimSpace(m.ID)
	if m.ID == "" || len(m.ID) > 64 {
		return 0, errHubBad("id must be 1 to 64 characters")
	}
	if strings.TrimSpace(m.Text) == "" {
		return 0, errHubBad("text is empty")
	}
	if ref, ok := b.Store.LookupRemote(s.ID, m.ID); ok && ref.MessageID != 0 {
		return ref.MessageID, nil
	}
	body := m.Text
	if m.ParseMode != "HTML" {
		body = Escape(body)
	}
	if r := []rune(body); len(r) > hubMaxText {
		body = string(r[:hubMaxText-1]) + "…"
	}
	head := "🖥 <b>" + Escape(s.Name) + "</b>"
	if m.LateS >= hubLateShown {
		head += " · <i>" + lateWords(m.LateS) + " late: this computer was out of reach</i>"
	}
	markup, actions := hubMarkup(m.Buttons)
	out := Out{Text: head + "\n" + body, ParseMode: "HTML", Markup: markup}
	msg, err := b.Out.Send(ctx, out)
	var ae *APIError
	if err != nil && errors.As(err, &ae) && ae.Code == http.StatusBadRequest && m.ParseMode == "HTML" {
		// Markup Telegram will not parse: the words, shown as they are,
		// rather than nothing.
		out.Text = head + "\n" + Escape(body)
		msg, err = b.Out.Send(ctx, out)
	}
	if err != nil {
		return 0, err
	}
	now := b.now().UnixMilli()
	b.Store.Remember(Ref{MessageID: msg.MessageID, Kind: "hub", At: now, Machine: s.ID, MachineName: s.Name,
		Remote: m.ID, Actions: actions, HubReply: m.Reply})
	_ = b.Store.Update(func(st *State) {
		if st.Carries == nil {
			st.Carries = map[string]Carried{}
		}
		st.Carries[s.ID] = Carried{Name: s.Name, LastAt: now}
	})
	if len(actions) > 0 || m.Reply {
		// Its buttons need someone reading: start if idle.
		b.mu.Lock()
		polling := b.polling
		b.mu.Unlock()
		if !polling {
			b.Wake()
		}
	}
	return msg.MessageID, nil
}

// lateWords is a delay in the largest unit that fits: "3 min", "2 h".
func lateWords(s int64) string {
	switch {
	case s < 3600:
		return strconv.FormatInt(max(1, s/60), 10) + " min"
	case s < 48*3600:
		return strconv.FormatInt(s/3600, 10) + " h"
	}
	return strconv.FormatInt(s/86400, 10) + " days"
}

// hubMarkup turns a sender's buttons into Telegram's, each action button
// calling back "h:<index>" into the returned actions. At most three rows of
// four; an unknown action or a URL that is not http(s) is dropped.
func hubMarkup(rows [][]HubButton) (*Markup, []string) {
	var out [][]InlineButton
	var actions []string
	for _, row := range rows {
		if len(out) == 3 {
			break
		}
		var r []InlineButton
		for _, hb := range row {
			if len(r) == 4 {
				break
			}
			text := clipRunes(strings.TrimSpace(hb.Text), 48)
			if text == "" {
				continue
			}
			switch {
			case hb.URL != "":
				u, err := url.Parse(hb.URL)
				if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
					continue
				}
				r = append(r, InlineButton{Text: text, URL: hb.URL})
			case hb.Action == ActApprove || hb.Action == ActDeny || hb.Action == ActMute:
				r = append(r, InlineButton{Text: text, CallbackData: "h:" + strconv.Itoa(len(actions))})
				actions = append(actions, hb.Action)
			}
		}
		if len(r) > 0 {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return nil, nil
	}
	return &Markup{InlineKeyboard: out}, actions
}

// hubWaiting reports a message from another computer, posted within
// hubWaitFor, that can still be answered: the bridge reads updates for it.
func (b *Bridge) hubWaiting() bool {
	now := b.now()
	refs := b.Store.Get().Refs
	for i := len(refs) - 1; i >= 0; i-- {
		r := refs[i]
		if r.Kind == "hub" && (len(r.Actions) > 0 || r.HubReply) && now.Sub(time.UnixMilli(r.At)) < hubWaitFor {
			return true
		}
	}
	return false
}

// hubPress hands a press under another computer's message to that computer.
func (b *Bridge) hubPress(ref Ref, arg string, toast func(string)) {
	i, err := strconv.Atoi(arg)
	if ref.Kind != "hub" || err != nil || i < 0 || i >= len(ref.Actions) {
		toast("I no longer know which computer this was.")
		return
	}
	b.queuePress(ref.Machine, HubPress{ID: ref.Remote, Action: ref.Actions[i]})
	toast("Sent to " + ref.MachineName + ".")
}

// hubReply hands a reply to another computer's message to that computer.
func (b *Bridge) hubReply(m *Message, ref Ref, text string) {
	if !ref.HubReply {
		b.say(m, "That message came from "+ref.MachineName+", and a reply to it goes nowhere. Reply to one about a session.")
		return
	}
	if strings.TrimSpace(text) == "" {
		return
	}
	b.queuePress(ref.Machine, HubPress{ID: ref.Remote, Action: ActReply, Text: text, Reply: m.MessageID})
}

func (b *Bridge) queuePress(machine string, p HubPress) {
	p.At = b.now().UnixMilli()
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.hub.presses == nil {
		b.hub.presses = map[string][]HubPress{}
	}
	b.hub.presses[machine] = append(b.hub.presses[machine], p)
	q := b.hub.presses[machine]
	if len(q) > hubPressMax {
		q = q[len(q)-hubPressMax:]
	}
	b.hub.presses[machine] = q
	if b.hub.wake != nil {
		close(b.hub.wake)
	}
	b.hub.wake = make(chan struct{})
}

// HubPresses hands a computer the presses and replies waiting for it,
// waiting up to wait for one when none is. Each is handed over once: a
// press lost on the way is lost, never acted on twice (a reply typed in
// twice is worse than one the owner sends again).
func (b *Bridge) HubPresses(ctx context.Context, s Sender, wait time.Duration) []HubPress {
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	for {
		b.mu.Lock()
		q := b.hub.presses[s.ID]
		if len(q) > 0 {
			delete(b.hub.presses, s.ID)
			b.mu.Unlock()
			return q
		}
		if b.hub.wake == nil {
			b.hub.wake = make(chan struct{})
		}
		wake := b.hub.wake
		b.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil
		case <-deadline.C:
			return nil
		case <-wake:
		}
	}
}

// HubResult shows what a computer did with a press: the message's buttons
// replaced by the outcome, a line under the reply, a 👍 on it.
func (b *Bridge) HubResult(ctx context.Context, s Sender, r HubResult) error {
	ref, ok := b.Store.LookupRemote(s.ID, r.ID)
	if !ok || ref.MessageID == 0 {
		return errHubUnknown
	}
	token, chat := b.Host.Bot()
	if token == "" || chat == "" {
		return ErrNotHolder
	}
	c := b.client(token)
	if r.Label != "" {
		b.editMu.Lock()
		err := c.EditMarkup(ctx, chat, ref.MessageID, &Markup{InlineKeyboard: [][]InlineButton{{{Text: clipRunes(r.Label, 60), CallbackData: "-"}}}})
		b.editMu.Unlock()
		if err != nil {
			b.Log.Info("telegram: could not mark another computer's message", "component", "telegram", "err", err)
		}
		b.Store.UpdateRef(ref.MessageID, func(rf *Ref) { rf.Actions = nil })
	}
	if r.React && r.Reply != 0 {
		if err := c.React(ctx, chat, r.Reply, "👍"); err != nil {
			b.Log.Info("telegram: could not mark a reply as sent", "component", "telegram", "err", err)
		}
	}
	if s := strings.TrimSpace(r.Say); s != "" {
		to := r.Reply
		if to == 0 {
			to = ref.MessageID
		}
		b.Out.Queue(Out{Text: clipRunes(s, 1000), ReplyTo: to})
	}
	return nil
}

// Handover gives this machine's bot to the computer that asks: the token,
// the paired chat and where reading stopped. This machine then forgets the
// bot exactly as Disconnect does, stops reading (Telegram lets one reader
// at a time), and remembers where the bot went. OnMoved, when set, hears
// who took it.
func (b *Bridge) Handover(ctx context.Context, s Sender) (Handover, error) {
	token, chat := b.Host.Bot()
	if token == "" || chat == "" {
		return Handover{}, ErrNotHolder
	}
	st := b.Store.Get()
	h := Handover{Token: token, ChatID: chat, ChatName: st.ChatName, BotID: st.BotID, BotUsername: st.BotUsername, Offset: st.Offset}
	if st.ChatID != chat {
		h.ChatName = ""
	}
	if err := b.Disconnect(); err != nil {
		return Handover{}, err
	}
	_ = b.Store.Update(func(st *State) { st.MovedTo = &Moved{Name: s.Name, At: b.now().UnixMilli()} })
	b.mu.Lock()
	b.hub.presses = nil
	b.mu.Unlock()
	b.Log.Info("telegram: the bot was handed to another computer", "component", "telegram", "to", s.Name)
	if b.OnMoved != nil {
		b.OnMoved(s)
	}
	return h, nil
}

// TakeOver makes this machine the bot's holder with what the old holder
// handed over: the token, the chat and the offset, so nothing is read twice
// and no new pairing is needed. from names the old holder in the chat.
func (b *Bridge) TakeOver(ctx context.Context, h Handover, self, from string) error {
	if strings.TrimSpace(h.Token) == "" || strings.TrimSpace(h.ChatID) == "" {
		return errors.New("the other computer handed over no bot")
	}
	_ = b.Store.Reset()
	if err := b.Host.SaveBot(h.Token); err != nil {
		return err
	}
	if err := b.Host.SaveChat(h.ChatID); err != nil {
		return err
	}
	_ = b.Store.Update(func(st *State) {
		st.BotID, st.BotUsername = h.BotID, h.BotUsername
		st.ChatID, st.ChatName, st.PairedAt = h.ChatID, h.ChatName, b.now().UnixMilli()
		st.Offset = h.Offset
	})
	b.setErr("")
	b.Wake()
	b.Out.Queue(Out{Text: fmt.Sprintf("🔁 This bot now runs on %s, moved from %s. Nothing to do here: the chat stays paired.", self, from)})
	return nil
}

// newHubID is a message id for the holder: random, so two computers never
// collide and a restart never reuses one.
func newHubID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
