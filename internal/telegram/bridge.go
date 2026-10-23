package telegram

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// The bridge: the owner's bot, paired to one chat, carrying the sessions'
// messages out and the owner's replies, commands and button presses back in
// (ADR-047).
//
// **Long polling, no listener.** The daemon asks Telegram for updates;
// nothing on this machine accepts a connection from it, and a laptop on
// mobile data is reached the same way as one on the office Wi-Fi.
//
// **One chat.** The first private chat to send the pairing code is the only
// one the bridge listens to; everything from any other chat is dropped
// without an answer, so a stranger who finds the bot learns nothing.
//
// **Rule 7 holds below the bridge.** A reply is typed only into a session
// Caprock started; for any other the answer is that it can only be watched.
// The host's Type refuses the rest too, as the agent manager does.
//
// **Alerts are free; talking back is Premium.** Mute, the help and the
// alerts themselves need no licence. A reply, /sessions, /new, /stop and an
// Approve or Deny need an active licence and the two-way switch on; without
// them the chat hears one short line saying so, at most once a day.

// Host is what the bridge needs from the daemon.
type Host interface {
	// Bot is the stored token and chat id ("" when not set up).
	Bot() (token, chatID string)
	// SaveBot stores a checked token; SaveChat the paired chat. Empty clears.
	SaveBot(token string) error
	SaveChat(chatID string) error
	// Licensed reports an active licence; ChatOn the two-way switch;
	// AlertsOn whether any alert kind is switched on.
	Licensed() bool
	ChatOn() bool
	AlertsOn() bool

	// Sessions lists the live sessions, newest first.
	Sessions(ctx context.Context) ([]Live, error)
	// Session describes one session; ok false when it is unknown.
	Session(ctx context.Context, id string) (Live, bool)
	// Type types text into a session Caprock started and presses Enter.
	Type(id, text string) error
	// Answer answers the permission prompt promptID the way the app's card
	// does: read off the screen, never a blind digit.
	Answer(id, promptID string, allow bool) error
	// Stop ends a session Caprock started.
	Stop(id string) error
	// Projects lists the owner's projects, for /new.
	Projects(ctx context.Context) ([]Project, error)
	// SpawnMode is the mode new sessions start in ("" for Claude Code's own
	// default).
	SpawnMode() string
	// Start starts Claude Code in dir with a first message, in mode.
	Start(ctx context.Context, dir, prompt, mode string) (string, error)

	// Forward sends a message forwarded from Telegram to a session Caprock
	// started, through the message queue: typed in now (queued 0) or held
	// until the turn ends (queued is its id), marked as from Telegram.
	Forward(ctx context.Context, id, text string) (queued int64, err error)
	// StartChat starts a new chat (no project, ADR-071) in mode with text
	// as its first message.
	StartChat(ctx context.Context, text, mode string) (string, error)
	// Continue carries on a session Caprock ended for sitting idle, with
	// text as its next message (--resume under its own id).
	Continue(ctx context.Context, id, text string) error
	// SaveFile writes a file fetched from Telegram where pasted files go
	// and returns its path; an error when its type is not one Caprock keeps.
	SaveFile(name, mimeType string, data []byte) (string, error)
}

// Live is a session as the bridge shows it.
type Live struct {
	ID string
	// Header is the session's line in HTML: "🟠 Claude Code · caprock · Fix
	// the cache test".
	Header string
	// Title is the session's name alone, plain, for a reply placeholder.
	Title string
	// Owned is a session Caprock started; Alive that its process runs.
	Owned, Alive bool
	// Waiting says a permission prompt is open.
	Waiting bool
	// State is a word or two: "working", "waiting for approval", "idle".
	State string
	// Working says a turn runs; Chat that it is a chat (ADR-071), not
	// work; LastAt when it last did anything. The forward picker sorts and
	// labels by them.
	Working bool
	Chat    bool
	LastAt  time.Time
	// IdleEnded says Caprock ended it for sitting idle with no tab: a reply
	// continues it rather than being refused.
	IdleEnded bool
}

// Project is a folder /new can start in.
type Project struct{ Name, Root string }

// ErrTokenRefused is Connect's answer when Telegram does not know a token.
// Written for the person reading it on the Settings screen.
var ErrTokenRefused error = sentence("Telegram does not recognise this token. Copy it again from @BotFather.")

// sentence is an error that reads as a sentence on a screen, capital and
// full stop included.
type sentence string

func (s sentence) Error() string { return string(s) }

// ErrBypassConsent is Start refusing a Bypass start that would open on
// Claude Code's own warning (ADR-041).
var ErrBypassConsent = errors.New("bypass needs a one-time consent first: in Caprock on your computer, start a session in Bypass and accept the warning")

const (
	// PairFor is how long a pairing code works.
	PairFor = 10 * time.Minute
	// pairTries is how many wrong codes end a pairing.
	pairTries = 5
	// staleAfter drops a message that waited this long to be read: it was
	// sent while the daemon was down, and typing it now would be typing
	// into a session that has moved on.
	staleAfter = 2 * time.Minute
	// confirmFor is how long a /stop or /new confirmation can be pressed.
	confirmFor = 10 * time.Minute
	// conversingFor is how long a session keeps answering in Telegram at
	// once after the owner last typed into it from there.
	conversingFor = time.Hour
	// premiumNoteEvery spaces the Premium line out.
	premiumNoteEvery = 24 * time.Hour
	// listMax bounds /sessions.
	listMax = 20
)

// PremiumURL is where the Premium line points.
const PremiumURL = "https://caprock.dev/premium/"

// Bridge runs the bot. Construct with New, then Run.
type Bridge struct {
	Host  Host
	Store *Store
	Out   *Outbox
	Log   *slog.Logger
	// Base overrides the API host (tests, preview stands); BaseFrom, when
	// Base is empty, is asked per call.
	Base     string
	BaseFrom func() string
	// PollWait is one long poll; 0 is 25 seconds.
	PollWait time.Duration
	Now      func() time.Time
	// ModuleAnswer writes an answer to a module's message into that
	// module's store (collection ModuleCollection, document doc); it refuses
	// a module the admin key no longer names. nil keeps none (module.go).
	ModuleAnswer func(ctx context.Context, module, doc string, data map[string]any) error

	// pinMu keeps one module pin change at a time, so a module never
	// ends up with two pinned messages.
	pinMu sync.Mutex
	// editMu keeps one change to a module message's buttons at a time: a
	// module's edit and the "✓ <label>" a press puts under the message.
	// The press's answer reaches the module before that mark is made, so
	// without it a module answering at once could have its new text and
	// buttons overwritten by the mark of the press it was answering.
	editMu sync.Mutex

	mu         sync.Mutex
	pair       *pairing
	lastErr    string
	polling    bool
	since      time.Time
	cancelPoll context.CancelFunc
	wake       chan struct{}
	lists      map[int64][]string // a /sessions message → its sessions, in order
	lastList   []string
	pendingNew map[int64]newReq
	conversing map[string]time.Time

	// Forwards (forward.go): the burst being gathered, the pickers posted,
	// the newest one, and queued forwards by their queue id.
	BurstWait  time.Duration
	burst      *burst
	pickers    map[int64]*picker
	lastPicker int64
	queuedFwd  map[int64]queuedFwd
	replyOnce  map[string]replyAsk
}

type pairing struct {
	code    string
	started time.Time
	tries   int
}

type newReq struct {
	dir, prompt, name string
	at                time.Time
}

// New returns a bridge for host, keeping its state in dir.
func New(host Host, dir string, log *slog.Logger) *Bridge {
	if log == nil {
		log = slog.Default()
	}
	b := &Bridge{Host: host, Store: OpenStore(dir), Log: log, wake: make(chan struct{}, 1),
		lists: map[int64][]string{}, pendingNew: map[int64]newReq{}, conversing: map[string]time.Time{},
		pickers: map[int64]*picker{}, queuedFwd: map[int64]queuedFwd{}}
	b.Out = NewOutbox(func() (*Client, string) {
		token, chat := host.Bot()
		if token == "" {
			return nil, ""
		}
		return b.client(token), chat
	})
	return b
}

func (b *Bridge) now() time.Time {
	if b.Now != nil {
		return b.Now()
	}
	return time.Now()
}

func (b *Bridge) client(token string) *Client {
	base := b.Base
	if base == "" && b.BaseFrom != nil {
		base = b.BaseFrom()
	}
	return &Client{Token: token, Base: base}
}

// Wake makes the bridge re-read its settings now: a token saved, a pairing
// started, a switch turned. A poll in flight is cut short.
func (b *Bridge) Wake() {
	b.mu.Lock()
	if b.cancelPoll != nil {
		b.cancelPoll()
	}
	b.mu.Unlock()
	select {
	case b.wake <- struct{}{}:
	default:
	}
}

// wanted reports whether the bridge should be reading updates: while
// pairing, and while a paired bot has anything to answer — a button under
// an alert, or the two-way chat.
func (b *Bridge) wanted() bool {
	token, chat := b.Host.Bot()
	if token == "" {
		return false
	}
	b.mu.Lock()
	pairing := b.pair != nil && b.now().Sub(b.pair.started) < PairFor
	b.mu.Unlock()
	return pairing || (chat != "" && (b.Host.AlertsOn() || b.Host.ChatOn() || b.moduleWaiting()))
}

// Run polls and sends until ctx ends.
func (b *Bridge) Run(ctx context.Context) {
	go b.Out.Run(ctx)
	idle := 30 * time.Second
	for ctx.Err() == nil {
		if !b.wanted() {
			b.setPolling(false)
			select {
			case <-ctx.Done():
				return
			case <-b.wake:
			case <-time.After(idle):
			}
			continue
		}
		token, _ := b.Host.Bot()
		pctx, cancel := context.WithCancel(ctx)
		b.mu.Lock()
		b.cancelPoll = cancel
		b.since = b.now()
		b.mu.Unlock()
		b.setPolling(true)
		p := &Poller{Client: b.client(token), Wait: b.PollWait, OnError: b.recordPollError}
		_, err := p.Run(pctx, b.Store.Get().Offset, func(u Update) bool {
			_ = b.Store.Update(func(st *State) {
				if u.UpdateID >= st.Offset {
					st.Offset = u.UpdateID + 1
				}
			})
			b.handle(ctx, u)
			return !b.wanted()
		})
		cancel()
		b.mu.Lock()
		b.cancelPoll = nil
		b.mu.Unlock()
		if errors.Is(err, ErrStopped) {
			// A refused token stays refused: wait for a new one.
			b.setPolling(false)
			b.setErr("Telegram refused the bot token. Paste it again from @BotFather.")
			select {
			case <-ctx.Done():
				return
			case <-b.wake:
			}
		}
	}
}

func (b *Bridge) recordPollError(err error) {
	if err == nil {
		b.setErr("")
		return
	}
	b.Log.Warn("telegram: reading updates failed", "component", "telegram", "err", err)
	b.setErr(err.Error())
}

func (b *Bridge) setErr(s string) {
	b.mu.Lock()
	b.lastErr = s
	b.mu.Unlock()
}

func (b *Bridge) setPolling(on bool) {
	b.mu.Lock()
	b.polling = on
	b.mu.Unlock()
}

// --- setup ---

// Connect checks a token with getMe and, when Telegram knows it, stores it.
// A different bot than the one stored starts over: its chat and messages
// belong to the old one.
func (b *Bridge) Connect(ctx context.Context, token string) (User, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return User{}, ErrNoToken
	}
	u, err := b.client(token).GetMe(ctx)
	if err != nil {
		if Unauthorized(err) {
			return User{}, ErrTokenRefused
		}
		return User{}, err
	}
	prev := b.Store.Get()
	if prev.BotID != 0 && prev.BotID != u.ID {
		_ = b.Store.Reset()
		if err := b.Host.SaveChat(""); err != nil {
			return User{}, err
		}
	}
	if err := b.Host.SaveBot(token); err != nil {
		return User{}, err
	}
	_ = b.Store.Update(func(st *State) { st.BotID, st.BotUsername = u.ID, u.Username })
	b.setErr("")
	b.Wake()
	return u, nil
}

// Disconnect forgets the bot, the chat and everything learned about them.
func (b *Bridge) Disconnect() error {
	b.CancelPairing()
	if err := b.Host.SaveBot(""); err != nil {
		return err
	}
	if err := b.Host.SaveChat(""); err != nil {
		return err
	}
	b.setErr("")
	b.mu.Lock()
	b.conversing = map[string]time.Time{}
	b.pickers, b.queuedFwd, b.replyOnce, b.lastPicker = map[int64]*picker{}, map[int64]queuedFwd{}, nil, 0
	b.mu.Unlock()
	err := b.Store.Reset()
	b.Wake()
	return err
}

// Pairing is a pairing in progress, as the Settings screen shows it.
type Pairing struct {
	Code      string `json:"code"`
	Link      string `json:"link,omitempty"`
	ExpiresMs int64  `json:"expires_ms"`
}

// StartPairing makes a new code; the first private chat to send it becomes
// the bridge's only chat.
func (b *Bridge) StartPairing() (Pairing, error) {
	token, _ := b.Host.Bot()
	if token == "" {
		return Pairing{}, errors.New("save a bot token first")
	}
	code, err := NewCode()
	if err != nil {
		return Pairing{}, err
	}
	b.mu.Lock()
	b.pair = &pairing{code: code, started: b.now()}
	b.mu.Unlock()
	b.Wake()
	return b.pairingView(), nil
}

// CancelPairing ends a pairing in progress.
func (b *Bridge) CancelPairing() {
	b.mu.Lock()
	b.pair = nil
	b.mu.Unlock()
}

func (b *Bridge) pairingView() Pairing {
	b.mu.Lock()
	p := b.pair
	b.mu.Unlock()
	if p == nil || b.now().Sub(p.started) >= PairFor {
		return Pairing{}
	}
	return Pairing{Code: p.code, Link: StartLink(b.Store.Get().BotUsername, p.code), ExpiresMs: p.started.Add(PairFor).UnixMilli()}
}

// Status is what Settings shows about the bridge. Never the token.
type Status struct {
	BotSet      bool   `json:"bot_set"`
	TokenMasked string `json:"token_masked,omitempty"`
	BotUsername string `json:"bot_username,omitempty"`
	ChatSet     bool   `json:"chat_set"`
	// ChatName is the paired chat's name; empty for a chat id typed by hand
	// before pairing existed, which ManualChat then says.
	ChatName   string   `json:"chat_name,omitempty"`
	ManualChat bool     `json:"manual_chat,omitempty"`
	Pairing    *Pairing `json:"pairing,omitempty"`
	Polling    bool     `json:"polling"`
	LastError  string   `json:"last_error,omitempty"`
	MuteAll    bool     `json:"mute_all,omitempty"`
	Muted      int      `json:"muted,omitempty"`
}

// Status reports the bridge's state.
func (b *Bridge) Status() Status {
	token, chat := b.Host.Bot()
	st := b.Store.Get()
	out := Status{BotSet: token != "", TokenMasked: MaskToken(token), BotUsername: st.BotUsername, ChatSet: chat != "",
		MuteAll: st.MuteAll, Muted: len(st.Muted)}
	if chat != "" {
		if st.ChatID == chat {
			out.ChatName = st.ChatName
		} else {
			out.ManualChat = true
		}
	}
	if p := b.pairingView(); p.Code != "" {
		out.Pairing = &p
	}
	b.mu.Lock()
	out.Polling, out.LastError = b.polling, b.lastErr
	b.mu.Unlock()
	return out
}

// ErrNotPaired is a photo asked for with no bot or no chat set up.
var ErrNotPaired = errors.New("telegram: connect a bot and pair a chat in Settings first")

// SendPhoto sends a PNG with a caption to the paired chat, now: a share
// card the owner chose to send with a click (POST /v1/telegram/photo). It
// does not go through the outbox — the person is watching the button and
// wants the outcome, not a queue — and needs only a bot and a chat, not the
// alerts or the two-way chat switched on.
func (b *Bridge) SendPhoto(ctx context.Context, png []byte, caption string) error {
	token, chat := b.Host.Bot()
	if token == "" || chat == "" {
		return ErrNotPaired
	}
	_, err := b.client(token).SendPhoto(ctx, chat, png, caption)
	return err
}

// --- conversations ---

// Converse marks a session as one the owner talks to from Telegram: its
// replies and questions go there at once, not after the alert's minute.
func (b *Bridge) Converse(id string) {
	b.mu.Lock()
	b.conversing[id] = b.now()
	b.mu.Unlock()
}

// Conversing reports whether the owner typed into a session from Telegram
// within the last hour.
func (b *Bridge) Conversing(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	at, ok := b.conversing[id]
	if ok && b.now().Sub(at) > conversingFor {
		delete(b.conversing, id)
		return false
	}
	return ok
}

// Muted reports whether a session sends nothing to Telegram.
func (b *Bridge) Muted(id string) bool { return b.Store.IsMuted(id) }

// Active reports whether two-way chat works right now: licensed, switched
// on, and a chat paired.
func (b *Bridge) Active() bool {
	_, chat := b.Host.Bot()
	return chat != "" && b.Host.ChatOn() && b.Host.Licensed()
}

// Deliver queues a message about a session and remembers it, so a reply or
// a button press finds the session again. done, when set, hears the outcome.
func (b *Bridge) Deliver(m Out, ref Ref, done func(error)) {
	prev := m.Sent
	m.Sent = func(msg Message, err error) {
		if err == nil {
			ref.MessageID = msg.MessageID
			b.Store.Remember(ref)
		}
		if prev != nil {
			prev(msg, err)
		}
		if done != nil {
			done(err)
		}
	}
	b.Out.Queue(m)
}

// --- updates ---

func (b *Bridge) handle(ctx context.Context, u Update) {
	if q := u.CallbackQuery; q != nil {
		b.handleCallback(ctx, q)
		return
	}
	m := u.Message
	if m == nil || (m.From != nil && m.From.IsBot) {
		return
	}
	if b.tryPair(ctx, u) {
		return
	}
	_, chat := b.Host.Bot()
	if chat == "" || strconv.FormatInt(m.Chat.ID, 10) != chat {
		// Not the paired chat: no answer, nothing logged but the fact.
		b.Log.Info("telegram: a message from another chat was ignored", "component", "telegram")
		return
	}
	b.mu.Lock()
	since := b.since
	b.mu.Unlock()
	if m.Date > 0 && time.Unix(m.Date, 0).Before(since.Add(-staleAfter)) {
		b.Log.Info("telegram: a message sent while Caprock was not reading was skipped", "component", "telegram")
		return
	}
	if forwarded(m) {
		// A forward, or a photo, file or voice note: gathered with the rest
		// of its burst, then one picker asks where it goes (forward.go).
		b.collect(m)
		return
	}
	text := strings.TrimSpace(m.Text)
	if strings.HasPrefix(text, "/") {
		b.command(ctx, m, text)
		return
	}
	if m.ReplyTo != nil {
		b.reply(ctx, m, text)
		return
	}
	if b.words(ctx, m, text) {
		return
	}
	b.hint(m)
}

// hint answers a plain message that is not a reply, a command or words for
// a forward.
func (b *Bridge) hint(m *Message) {
	if !b.gate(m) {
		return
	}
	b.say(m, "Reply to one of my messages to talk to that session, or send /sessions. Forward me messages to send them to a session.")
}

// tryPair reads a message as a pairing attempt while one is open. true when
// the message was one and nothing else should read it.
func (b *Bridge) tryPair(ctx context.Context, u Update) bool {
	b.mu.Lock()
	p := b.pair
	if p != nil && b.now().Sub(p.started) >= PairFor {
		b.pair, p = nil, nil
	}
	code := ""
	if p != nil {
		code = p.code
	}
	b.mu.Unlock()
	if p == nil {
		return false
	}
	chat, ok, match := PairAttempt(u, code)
	if !ok {
		return false
	}
	to := strconv.FormatInt(chat.ID, 10)
	direct := func(text string) {
		// Not through the outbox: the chat is not the paired one (yet).
		token, _ := b.Host.Bot()
		_, _ = b.client(token).SendMessage(ctx, Send{ChatID: to, Text: text})
	}
	if !match {
		b.mu.Lock()
		if b.pair != nil {
			b.pair.tries++
			if b.pair.tries >= pairTries {
				b.pair = nil
			}
		}
		b.mu.Unlock()
		direct("That code does not match. Check the one Caprock shows in Settings → Telegram.")
		return true
	}
	if chat.Type != "private" {
		direct("Pair from a private chat with this bot, not a group: anyone in a group could talk to your sessions.")
		return true
	}
	if err := b.Host.SaveChat(to); err != nil {
		direct("Caprock could not save this chat: " + err.Error())
		return true
	}
	_ = b.Store.Update(func(st *State) {
		st.ChatID, st.ChatName, st.PairedAt = to, chat.Name(), b.now().UnixMilli()
		st.Refs, st.Muted, st.MuteAll = nil, nil, false
	})
	b.mu.Lock()
	b.pair = nil
	b.mu.Unlock()
	token, _ := b.Host.Bot()
	_ = b.client(token).SetCommands(ctx, Commands)
	b.Out.Queue(Out{Text: "✅ Paired with Caprock. This chat is the only one this bot listens to.\n\n" + b.helpText(), ParseMode: "HTML"})
	b.Log.Info("telegram: a chat was paired", "component", "telegram")
	return true
}

// Commands is the bot's menu.
var Commands = []Command{
	{"sessions", "Live sessions, numbered"},
	{"new", "Start Claude Code: /new <project> <message>"},
	{"stop", "Stop a session: /stop <number>"},
	{"mute", "Mute a session, or all: /mute <number|all>"},
	{"unmute", "Hear a session again: /unmute <number|all>"},
	{"help", "What this bot can do"},
}

func (b *Bridge) helpText() string {
	var s strings.Builder
	s.WriteString("<b>Alerts</b> come here when a session needs you or has finished (Settings → Telegram).\n")
	s.WriteString("/mute — under a message, or <code>/mute 2</code>, <code>/mute all</code>; /unmute undoes it.\n\n")
	s.WriteString("<b>Talking to your agents</b> (Premium):\n")
	s.WriteString("• Reply to a session's message to type into it and press Enter.\n")
	s.WriteString("• /sessions — the live ones, numbered.\n")
	s.WriteString("• <code>/new caprock fix the flaky test</code> — start Claude Code in a project.\n")
	s.WriteString("• <code>/stop 2</code> — stop one Caprock started.\n")
	s.WriteString("• Approve and Deny under a question answer it.\n")
	s.WriteString("• Forward me messages, photos, files or voice notes and pick a session: they go in as one message.\n\n")
	s.WriteString("Caprock only types into sessions it started itself; the others it watches.")
	return s.String()
}

// gate says whether two-way chat is open; when it is not, the chat hears
// why, at most once a day.
func (b *Bridge) gate(m *Message) bool {
	if b.Host.Licensed() && b.Host.ChatOn() {
		return true
	}
	st := b.Store.Get()
	if b.now().Sub(time.UnixMilli(st.PremiumNoteAt)) < premiumNoteEvery {
		return false
	}
	_ = b.Store.Update(func(st *State) { st.PremiumNoteAt = b.now().UnixMilli() })
	if !b.Host.Licensed() {
		b.say(m, "Talking to your agents from Telegram is part of Caprock Premium: "+PremiumURL+" — alerts and /mute stay free.")
		return false
	}
	b.say(m, "Two-way chat is off. Turn it on in Caprock → Settings → Telegram.")
	return false
}

// say answers a message in the chat, threaded under it. Plain text.
func (b *Bridge) say(m *Message, text string) {
	b.Out.Queue(Out{Text: text, ReplyTo: m.MessageID})
}

// command runs a /command.
func (b *Bridge) command(ctx context.Context, m *Message, text string) {
	name, args, _ := strings.Cut(text, " ")
	name = strings.ToLower(strings.TrimPrefix(name, "/"))
	if at := strings.IndexByte(name, '@'); at >= 0 {
		name = name[:at]
	}
	args = strings.TrimSpace(args)
	switch name {
	case "start", "help":
		b.Out.Queue(Out{Text: b.helpText(), ParseMode: "HTML"})
	case "mute":
		b.mute(ctx, m, args, true)
	case "unmute":
		b.mute(ctx, m, args, false)
	case "sessions":
		if b.gate(m) {
			b.sessions(ctx)
		}
	case "new":
		if b.gate(m) {
			b.newSession(ctx, m, args)
		}
	case "stop":
		if b.gate(m) {
			b.stop(ctx, m, args)
		}
	default:
		b.say(m, "I don't know that one. /help lists what I do.")
	}
}

// target is the session a command names: by its /sessions number, or by
// the message it replies to.
func (b *Bridge) target(m *Message, arg string) (string, string) {
	if arg != "" {
		n, err := strconv.Atoi(arg)
		b.mu.Lock()
		list := b.lastList
		b.mu.Unlock()
		if err != nil || n < 1 || n > len(list) {
			return "", "No session " + arg + ". Send /sessions for the numbers."
		}
		return list[n-1], ""
	}
	if m.ReplyTo != nil {
		if ref, ok := b.Store.Lookup(m.ReplyTo.MessageID); ok && ref.SessionID != "" {
			return ref.SessionID, ""
		}
		return "", "I don't know which session that message was about."
	}
	return "", ""
}

func (b *Bridge) mute(ctx context.Context, m *Message, arg string, on bool) {
	if strings.EqualFold(arg, "all") || (arg == "" && m.ReplyTo == nil) {
		_ = b.Store.Update(func(st *State) {
			st.MuteAll = on
			if !on {
				st.Muted = nil
			}
		})
		if on {
			b.say(m, "Muted: nothing will come here until /unmute.")
		} else {
			b.say(m, "Unmuted: alerts come here again.")
		}
		return
	}
	id, problem := b.target(m, arg)
	if id == "" {
		b.say(m, problem)
		return
	}
	b.setMuted(id, on)
	what := "this session"
	if s, ok := b.Host.Session(ctx, id); ok {
		what = s.Title
	}
	if on {
		b.say(m, "Muted "+what+". /unmute to hear it again.")
	} else {
		b.say(m, "Unmuted "+what+".")
	}
}

func (b *Bridge) setMuted(id string, on bool) {
	_ = b.Store.Update(func(st *State) {
		if st.Muted == nil {
			st.Muted = map[string]int64{}
		}
		if on {
			st.Muted[id] = b.now().UnixMilli()
		} else {
			delete(st.Muted, id)
		}
	})
}

func (b *Bridge) sessions(ctx context.Context) {
	list, err := b.Host.Sessions(ctx)
	if err != nil {
		b.Out.Queue(Out{Text: "Could not read the sessions: " + err.Error()})
		return
	}
	if len(list) == 0 {
		b.Out.Queue(Out{Text: "No live sessions. Start one with /new <project> <message>."})
		return
	}
	if len(list) > listMax {
		list = list[:listMax]
	}
	var s strings.Builder
	ids := make([]string, len(list))
	var row []InlineButton
	var rows [][]InlineButton
	for i, l := range list {
		ids[i] = l.ID
		fmt.Fprintf(&s, "<b>%d.</b> %s", i+1, l.Header)
		if l.State != "" {
			s.WriteString(" — " + Escape(l.State))
		}
		if !l.Owned {
			s.WriteString(" · <i>watch only</i>")
		}
		s.WriteString("\n")
		if l.Owned && l.Alive {
			row = append(row, InlineButton{Text: strconv.Itoa(i + 1), CallbackData: "t:" + strconv.Itoa(i+1)})
			if len(row) == 5 {
				rows, row = append(rows, row), nil
			}
		}
	}
	if len(row) > 0 {
		rows = append(rows, row)
	}
	s.WriteString("\nTap a number to talk to that session, or <code>/stop 2</code>.")
	b.mu.Lock()
	b.lastList = ids
	b.mu.Unlock()
	out := Out{Text: s.String(), ParseMode: "HTML"}
	if len(rows) > 0 {
		out.Markup = &Markup{InlineKeyboard: rows}
	}
	out.Sent = func(msg Message, err error) {
		if err == nil {
			b.mu.Lock()
			b.lists[msg.MessageID] = ids
			b.mu.Unlock()
		}
	}
	b.Out.Queue(out)
}

// reply types a reply into the session its message is about.
func (b *Bridge) reply(ctx context.Context, m *Message, text string) {
	ref, ok := b.lookup(ctx, m.ReplyTo.MessageID)
	if ok && ref.Module != "" {
		// A module's question: its answer goes to the module, free, never
		// to a session.
		b.moduleReply(ctx, m, ref, text)
		return
	}
	if !ok || ref.SessionID == "" {
		if b.gate(m) {
			b.say(m, "I don't know which session that message was about. Send /sessions to pick one.")
		}
		return
	}
	if !b.gate(m) {
		return
	}
	s, known := b.Host.Session(ctx, ref.SessionID)
	switch {
	case !known || !s.Owned:
		b.say(m, "I can only watch this one: it was started outside Caprock, and Caprock never types into a session it did not start. Continue it in Caprock to talk to it from here.")
		return
	case !s.Alive && s.IdleEnded && text != "":
		// Ended only because it sat idle: the reply carries it on, from
		// where it stopped.
		if err := b.Host.Continue(ctx, ref.SessionID, text); err != nil {
			b.say(m, "Could not continue it: "+err.Error())
			return
		}
		b.Converse(ref.SessionID)
		b.say(m, "It had ended after sitting idle; continued it with your message.")
		return
	case !s.Alive:
		b.say(m, "That session has ended. Start another with /new.")
		return
	case s.Waiting:
		b.say(m, "It is waiting for an approval. Answer that first — with the buttons, or in the terminal.")
		return
	case text == "":
		return
	}
	if err := b.Host.Type(ref.SessionID, text); err != nil {
		b.say(m, "Could not type it: "+err.Error())
		return
	}
	b.Converse(ref.SessionID)
	token, chat := b.Host.Bot()
	if err := b.client(token).React(ctx, chat, m.MessageID, "👍"); err != nil {
		b.Log.Info("telegram: could not mark a reply as sent", "component", "telegram", "err", err)
	}
}

func (b *Bridge) stop(ctx context.Context, m *Message, arg string) {
	id, problem := b.target(m, arg)
	if id == "" {
		if problem == "" {
			problem = "Which one? Send /sessions, then /stop with its number."
		}
		b.say(m, problem)
		return
	}
	s, known := b.Host.Session(ctx, id)
	if !known || !s.Owned {
		b.say(m, "I can only stop sessions Caprock started. This one runs in a terminal of its own.")
		return
	}
	if !s.Alive {
		b.say(m, "That session has already ended.")
		return
	}
	b.Deliver(Out{
		Text:      "Stop " + s.Header + "?\nIts process ends; the conversation can be continued later.",
		ParseMode: "HTML",
		Markup:    &Markup{InlineKeyboard: [][]InlineButton{{{Text: "Stop it", CallbackData: "k"}, {Text: "Keep it", CallbackData: "x"}}}},
	}, Ref{SessionID: id, Kind: "stop"}, nil)
}

func (b *Bridge) newSession(ctx context.Context, m *Message, args string) {
	name, prompt, _ := strings.Cut(args, " ")
	prompt = strings.TrimSpace(prompt)
	if name == "" {
		b.say(m, "Which project? /new <project> <first message>, for example /new caprock fix the flaky test.")
		return
	}
	projects, err := b.Host.Projects(ctx)
	if err != nil {
		b.say(m, "Could not read the projects: "+err.Error())
		return
	}
	p, problem := pickProject(projects, name)
	if problem != "" {
		b.say(m, problem)
		return
	}
	req := newReq{dir: p.Root, prompt: prompt, name: p.Name, at: b.now()}
	if b.Host.SpawnMode() == "bypassPermissions" {
		b.Out.Queue(Out{
			Text:      "Start Claude Code in <b>" + Escape(p.Name) + "</b> in <b>Bypass</b>? It will not ask before running commands or editing files.",
			ParseMode: "HTML",
			Markup: &Markup{InlineKeyboard: [][]InlineButton{{
				{Text: "Start in Bypass", CallbackData: "b"}, {Text: "Ask first instead", CallbackData: "d"}, {Text: "Cancel", CallbackData: "x"},
			}}},
			Sent: func(msg Message, err error) {
				if err == nil {
					b.mu.Lock()
					b.pendingNew[msg.MessageID] = req
					b.mu.Unlock()
				}
			},
		})
		return
	}
	b.start(ctx, req, b.Host.SpawnMode())
}

func (b *Bridge) start(ctx context.Context, req newReq, mode string) {
	id, err := b.Host.Start(ctx, req.dir, req.prompt, mode)
	if err != nil {
		b.Out.Queue(Out{Text: "Could not start it: " + err.Error()})
		return
	}
	b.Converse(id)
	header := "Claude Code · " + Escape(req.name)
	if s, ok := b.Host.Session(ctx, id); ok && s.Header != "" {
		header = s.Header
	}
	text := "▶️ Started: " + header
	if req.prompt == "" {
		text += "\nReply to this message to give it its first instruction."
	} else {
		text += "\nIts answer comes here. Reply to this message to add to it."
	}
	b.Deliver(Out{Text: text, ParseMode: "HTML"}, Ref{SessionID: id, Kind: "reply"}, nil)
}

// pickProject finds the project a name means: exact, then the only one it
// starts, then the only one containing it, ignoring case.
func pickProject(ps []Project, name string) (Project, string) {
	q := strings.ToLower(name)
	var prefix, contains []Project
	for _, p := range ps {
		n := strings.ToLower(p.Name)
		switch {
		case n == q:
			return p, ""
		case strings.HasPrefix(n, q):
			prefix = append(prefix, p)
		case strings.Contains(n, q):
			contains = append(contains, p)
		}
	}
	for _, set := range [][]Project{prefix, contains} {
		if len(set) == 1 {
			return set[0], ""
		}
		if len(set) > 1 {
			return Project{}, "More than one project matches " + name + ": " + names(set) + "."
		}
	}
	if len(ps) == 0 {
		return Project{}, "No projects yet. Add one in Caprock first."
	}
	return Project{}, "No project called " + name + ". Yours: " + names(ps) + "."
}

func names(ps []Project) string {
	out := make([]string, 0, 10)
	for i, p := range ps {
		if i == 10 {
			out = append(out, "…")
			break
		}
		out = append(out, p.Name)
	}
	return strings.Join(out, ", ")
}

// --- buttons ---

func (b *Bridge) handleCallback(ctx context.Context, q *CallbackQuery) {
	token, chat := b.Host.Bot()
	c := b.client(token)
	toast := func(text string) { _ = c.AnswerCallbackQuery(ctx, q.ID, text) }
	if q.Message == nil || chat == "" || strconv.FormatInt(q.Message.Chat.ID, 10) != chat {
		toast("")
		return
	}
	msgID := q.Message.MessageID
	ref, _ := b.lookup(ctx, msgID)
	premium := func() bool {
		if b.Host.Licensed() && b.Host.ChatOn() {
			return true
		}
		if !b.Host.Licensed() {
			toast("Answering from Telegram is part of Caprock Premium.")
		} else {
			toast("Two-way chat is off: Settings → Telegram.")
		}
		return false
	}
	done := func(label string) {
		_ = c.EditMarkup(ctx, chat, msgID, &Markup{InlineKeyboard: [][]InlineButton{{{Text: label, CallbackData: "-"}}}})
	}
	switch data := q.Data; {
	case data == "-":
		toast("")
	case data == "m" || data == "u":
		if ref.SessionID == "" {
			toast("I no longer know which session this was.")
			return
		}
		b.setMuted(ref.SessionID, data == "m")
		if data == "m" {
			toast("Muted this session.")
			_ = c.EditMarkup(ctx, chat, msgID, &Markup{InlineKeyboard: [][]InlineButton{{{Text: "🔔 Unmute", CallbackData: "u"}}}})
		} else {
			toast("Unmuted.")
			_ = c.EditMarkup(ctx, chat, msgID, &Markup{InlineKeyboard: [][]InlineButton{{{Text: "🔕 Mute this session", CallbackData: "m"}}}})
		}
	case data == "y" || data == "n":
		if !premium() {
			return
		}
		if ref.SessionID == "" || ref.PromptID == "" {
			toast("I no longer know which question this was. Answer in Caprock.")
			return
		}
		if err := b.Host.Answer(ref.SessionID, ref.PromptID, data == "y"); err != nil {
			toast(clipToast(err.Error()))
			return
		}
		b.Converse(ref.SessionID)
		if data == "y" {
			toast("Approved.")
			done("✅ Approved from Telegram")
		} else {
			toast("Denied.")
			done("✖️ Denied from Telegram")
		}
	case data == "k":
		if !premium() {
			return
		}
		if ref.Kind != "stop" || ref.SessionID == "" || b.now().Sub(time.UnixMilli(ref.At)) > confirmFor {
			toast("That question has expired. Send /stop again.")
			done("Expired")
			return
		}
		if err := b.Host.Stop(ref.SessionID); err != nil {
			toast(clipToast(err.Error()))
			return
		}
		toast("Stopped.")
		done("⏹ Stopped")
	case data == "x":
		b.mu.Lock()
		delete(b.pendingNew, msgID)
		b.mu.Unlock()
		toast("")
		done("Cancelled")
	case data == "b" || data == "d":
		if !premium() {
			return
		}
		b.mu.Lock()
		req, ok := b.pendingNew[msgID]
		delete(b.pendingNew, msgID)
		b.mu.Unlock()
		if !ok || b.now().Sub(req.at) > confirmFor {
			toast("That question has expired. Send /new again.")
			done("Expired")
			return
		}
		mode := "bypassPermissions"
		label := "Starting in Bypass…"
		if data == "d" {
			mode, label = "default", "Starting, asking first…"
		}
		toast("")
		done(label)
		b.start(ctx, req, mode)
	case strings.HasPrefix(data, "t:"):
		if !premium() {
			return
		}
		n, _ := strconv.Atoi(strings.TrimPrefix(data, "t:"))
		b.mu.Lock()
		ids := b.lists[msgID]
		b.mu.Unlock()
		if n < 1 || n > len(ids) {
			toast("That list is out of date. Send /sessions again.")
			return
		}
		s, ok := b.Host.Session(ctx, ids[n-1])
		if !ok || !s.Owned || !s.Alive {
			toast("That session is no longer running.")
			return
		}
		toast("")
		b.Deliver(Out{
			Text:       s.Header + "\nReply to this message to type into it.",
			ParseMode:  "HTML",
			ForceReply: &ForceReply{ForceReply: true, Placeholder: clipRunes("Message to "+s.Title, 64)},
		}, Ref{SessionID: s.ID, Kind: "reply"}, nil)
	case strings.HasPrefix(data, moduleData):
		b.modulePress(ctx, c, chat, msgID, ref, strings.TrimPrefix(data, moduleData), toast)
	case strings.HasPrefix(data, "f:"):
		b.forwardPress(ctx, c, chat, msgID, strings.TrimPrefix(data, "f:"), toast, premium)
	default:
		toast("")
	}
}

// lookup finds what a message is about, waiting a moment when it is not
// known yet: a message's id is learnt when Telegram answers the send, and an
// update about it can be read before that answer is.
func (b *Bridge) lookup(ctx context.Context, messageID int64) (Ref, bool) {
	for i := 0; ; i++ {
		if ref, ok := b.Store.Lookup(messageID); ok || i == 20 {
			return ref, ok
		}
		if !sleep(ctx, 50*time.Millisecond) {
			return Ref{}, false
		}
	}
}

func clipToast(s string) string { return clipRunes(s, 190) }

func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}

// Escape escapes text for Telegram's HTML parse mode, which needs exactly
// these three.
func Escape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}
