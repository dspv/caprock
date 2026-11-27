package telegram

import (
	"context"
	"strings"
	"time"
)

// The sender's half of one bot for several computers (hub.go): a computer
// with no bot of its own that hands its messages to the holder, and acts on
// what comes back.

// ViaStatus is how Settings shows a computer that sends through a holder.
type ViaStatus struct {
	// Machine is the holder's id among the computers this one reaches;
	// Name what this machine calls it.
	Machine string `json:"machine"`
	Name    string `json:"name"`
	// Queued is how many messages wait for it; Waiting says the last try to
	// reach it failed, LastError in whose words.
	Queued    int    `json:"queued"`
	Waiting   bool   `json:"waiting,omitempty"`
	LastError string `json:"last_error,omitempty"`
	// LastSentMs is when it last took a message (unix ms, this clock).
	LastSentMs int64 `json:"last_sent_ms,omitempty"`
	// Dropped counts messages that waited past the queue's bounds since
	// this daemon started.
	Dropped int `json:"dropped,omitempty"`
}

// Candidate is one computer this machine reaches, as Settings → Telegram
// lists them for "send through": whether it holds a bot, and which.
type Candidate struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Holder      bool   `json:"holder"`
	BotUsername string `json:"bot_username,omitempty"`
	ChatName    string `json:"chat_name,omitempty"`
	// Error is why it could not be asked: offline, not allowed there yet.
	Error string `json:"error,omitempty"`
}

// routing reports whether this machine sends through a holder: no bot of its
// own and a holder chosen.
func (b *Bridge) routing() bool {
	if b.Via == nil || b.Route == nil || b.Via() == "" {
		return false
	}
	token, chat := b.Host.Bot()
	return token == "" || chat == ""
}

// Routing reports whether this machine's messages go through another
// computer's bot.
func (b *Bridge) Routing() bool { return b.routing() }

// route hands a message to the holder through Route, remembering what it is
// about under the id it is handed over with.
func (b *Bridge) route(m Out, ref Ref, done func(error)) {
	id := newHubID()
	ref.MessageID, ref.Remote = 0, id
	b.Store.Remember(ref)
	hm := ToHub(m, id, ref.SessionID != "")
	b.Route(hm, func(err error) {
		if m.Sent != nil {
			m.Sent(Message{}, err)
		}
		if done != nil {
			done(err)
		}
	})
}

// SendNow sends one message and waits for its outcome: through this
// machine's own bot, or handed to the holder (where an unreachable holder
// keeps it queued and the error says so).
func (b *Bridge) SendNow(ctx context.Context, m Out) error {
	if !b.routing() {
		_, err := b.Out.Send(ctx, m)
		return err
	}
	done := make(chan error, 1)
	b.route(m, Ref{Kind: "alert"}, func(err error) { done <- err })
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ToHub is a message as the holder takes it: the text as it is, the
// alert's buttons as actions (Approve "y", Deny "n", Mute "m") and URLs,
// any other button dropped. reply says a Telegram reply to it is carried
// back (it is about a session).
func ToHub(m Out, id string, reply bool) HubMessage {
	hm := HubMessage{ID: id, Text: m.Text, ParseMode: m.ParseMode, Reply: reply}
	if m.Markup != nil {
		for _, row := range m.Markup.InlineKeyboard {
			var r []HubButton
			for _, ib := range row {
				switch {
				case ib.URL != "":
					r = append(r, HubButton{Text: ib.Text, URL: ib.URL})
				case ib.CallbackData == "y":
					r = append(r, HubButton{Text: ib.Text, Action: ActApprove})
				case ib.CallbackData == "n":
					r = append(r, HubButton{Text: ib.Text, Action: ActDeny})
				case ib.CallbackData == "m":
					r = append(r, HubButton{Text: ib.Text, Action: ActMute})
				}
			}
			if len(r) > 0 {
				hm.Buttons = append(hm.Buttons, r)
			}
		}
	}
	return hm
}

// FromHub is a queued message sent through this machine's own bot after all
// (it became the holder while the message waited): the alert's buttons
// again, and the session it was about remembered under its Telegram id.
func (b *Bridge) FromHub(hm HubMessage) {
	m := Out{Text: hm.Text, ParseMode: hm.ParseMode}
	var rows [][]InlineButton
	for _, row := range hm.Buttons {
		var r []InlineButton
		for _, hb := range row {
			switch {
			case hb.URL != "":
				r = append(r, InlineButton{Text: hb.Text, URL: hb.URL})
			case hb.Action == ActApprove:
				r = append(r, InlineButton{Text: hb.Text, CallbackData: "y"})
			case hb.Action == ActDeny:
				r = append(r, InlineButton{Text: hb.Text, CallbackData: "n"})
			case hb.Action == ActMute:
				r = append(r, InlineButton{Text: hb.Text, CallbackData: "m"})
			}
		}
		if len(r) > 0 {
			rows = append(rows, r)
		}
	}
	if len(rows) > 0 {
		m.Markup = &Markup{InlineKeyboard: rows}
	}
	ref, _ := b.Store.LookupRemote("", hm.ID)
	ref.Remote = ""
	b.Deliver(m, ref, nil)
}

// Act does what a press or a reply under one of this machine's messages
// asked, on this machine and by its own rules: the session it was about, a
// licence and the two-way switch here for anything but Mute, and rule 7 in
// Host. The result is what the holder shows in the chat.
func (b *Bridge) Act(ctx context.Context, p HubPress) HubResult {
	res := HubResult{ID: p.ID, Reply: p.Reply}
	ref, ok := b.Store.LookupRemote("", p.ID)
	if !ok || ref.SessionID == "" {
		res.Say = "This computer no longer knows which session that was."
		return res
	}
	premium := func() bool {
		if b.Host.Licensed() && b.Host.ChatOn() {
			return true
		}
		if !b.Host.Licensed() {
			res.Say = "Talking to this computer's sessions from Telegram is part of Caprock Premium: " + PremiumURL
		} else {
			res.Say = "Two-way chat is off on this computer: Settings → Telegram there."
		}
		return false
	}
	switch p.Action {
	case ActMute:
		b.setMuted(ref.SessionID, true)
		res.Label = "🔕 Muted"
	case ActApprove, ActDeny:
		if !premium() {
			return res
		}
		if ref.PromptID == "" {
			res.Say = "I no longer know which question this was. Answer it in Caprock."
			return res
		}
		if err := b.Host.Answer(ref.SessionID, ref.PromptID, p.Action == ActApprove); err != nil {
			res.Say = "Could not answer: " + err.Error()
			return res
		}
		b.Converse(ref.SessionID)
		res.Label = "✅ Approved from Telegram"
		if p.Action == ActDeny {
			res.Label = "✖️ Denied from Telegram"
		}
	case ActReply:
		if !premium() {
			return res
		}
		res.Say, res.React = b.typeReply(ctx, ref.SessionID, strings.TrimSpace(p.Text))
	default:
		res.Say = "This computer does not know that button."
	}
	return res
}

// typeReply types a reply into a session as reply() does for this machine's
// own chat, and says how it went: a line for the chat, or a 👍.
func (b *Bridge) typeReply(ctx context.Context, id, text string) (string, bool) {
	s, known := b.Host.Session(ctx, id)
	switch {
	case !known || !s.Owned:
		return "I can only watch this one: it was started outside Caprock, and Caprock never types into a session it did not start.", false
	case !s.Alive && s.IdleEnded && text != "":
		if err := b.Host.Continue(ctx, id, text); err != nil {
			return "Could not continue it: " + err.Error(), false
		}
		b.Converse(id)
		return "It had ended after sitting idle; continued it with your message.", false
	case !s.Alive:
		return "That session has ended.", false
	case s.Waiting:
		return "It is waiting for an approval. Answer that first — with the buttons, or in the terminal.", false
	case text == "":
		return "", false
	}
	if err := b.Host.Type(id, text); err != nil {
		return "Could not type it: " + err.Error(), false
	}
	b.Converse(id)
	return "", true
}

// viaPollFor is how long after handing a message over the sender keeps
// asking for presses under it. A later press waits on the holder (in
// memory, up to 100) until the next message opens the window again, so the
// link is not held open for a day after every alert.
const viaPollFor = time.Hour

// Answerable reports a message about a session handed to the holder within
// viaPollFor: the sender asks for presses only then.
func (b *Bridge) Answerable() bool {
	now := b.now()
	refs := b.Store.Get().Refs
	for i := len(refs) - 1; i >= 0; i-- {
		r := refs[i]
		if r.Remote != "" && r.Machine == "" && r.SessionID != "" && now.Sub(time.UnixMilli(r.At)) < viaPollFor {
			return true
		}
	}
	return false
}
