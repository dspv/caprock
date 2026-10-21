package daemon

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/alerts"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/license"
	"github.com/dspv/caprock/internal/relay"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/telegram"
)

// The daemon's half of the Telegram bridge (ADR-047): what the bridge needs
// to know about sessions and settings, and the messages it carries out.

// newTelegram builds the bridge; run() starts it once the agent manager and
// the API it calls exist. It reads updates only while a bot is set up and
// something needs answering, so a machine with no bot makes no call at all.
func (d *Daemon) newTelegram() *telegram.Bridge {
	b := telegram.New(&tgHost{d: d}, d.opt.DataDir, d.log)
	b.BaseFrom = d.telegramBase
	return b
}

// telegramBase is the API host: a stand-in in tests and preview stands,
// Telegram's own otherwise.
func (d *Daemon) telegramBase() string {
	d.report.mu.RLock()
	base := d.report.base
	d.report.mu.RUnlock()
	if base == "" {
		base = os.Getenv(EnvTelegramAPI)
	}
	return base
}

// tgHost is the daemon as the bridge sees it.
type tgHost struct{ d *Daemon }

func (h *tgHost) Bot() (string, string) {
	cfg := h.d.config()
	return strings.TrimSpace(cfg.ReportBotToken), strings.TrimSpace(cfg.ReportChatID)
}

func (h *tgHost) saveConfig(f func(*config.Config)) error {
	h.d.cfgMu.Lock()
	f(&h.d.opt.Config)
	cfg := h.d.opt.Config
	h.d.cfgMu.Unlock()
	return config.Save(h.d.opt.DataDir, cfg)
}

// SaveBot keeps the token in the secret store, never in config.json. The
// bridge saves only a token Telegram's getMe accepted (or "" to disconnect),
// so the last alert's outcome, which was the old bot's, is forgotten.
func (h *tgHost) SaveBot(token string) error {
	token = strings.TrimSpace(token)
	if err := h.d.putSecret(context.Background(), telegramSecret, token); err != nil {
		return err
	}
	if err := h.saveConfig(func(c *config.Config) { applySecret(c, telegramSecret, token) }); err != nil {
		return err
	}
	h.d.phone.botChanged()
	return nil
}

// SaveChat stores the paired chat; a different chat forgets the last
// alert's outcome, which was about the old one.
func (h *tgHost) SaveChat(chat string) error {
	chat = strings.TrimSpace(chat)
	changed := chat != strings.TrimSpace(h.d.config().ReportChatID)
	if err := h.saveConfig(func(c *config.Config) { c.ReportChatID = chat }); err != nil {
		return err
	}
	if changed {
		h.d.phone.botChanged()
	}
	return nil
}

func (h *tgHost) Licensed() bool {
	return license.Parse(h.d.config().LicenseKey, time.Now()).Active
}

func (h *tgHost) ChatOn() bool { return h.d.config().TelegramChatOn() }

func (h *tgHost) AlertsOn() bool {
	cfg := h.d.config()
	return cfg.AlertApprovalOn() || cfg.AlertFinishedOn()
}

func (h *tgHost) Sessions(ctx context.Context) ([]telegram.Live, error) {
	list, err := store.ListSessions(ctx, h.d.store.DB(), true, 60)
	if err != nil {
		return nil, err
	}
	var out []telegram.Live
	for _, s := range list {
		if s.Status == "ended" {
			continue
		}
		if h.d.mgr != nil && h.d.mgr.IsShell(s.SessionID) {
			continue
		}
		out = append(out, h.live(ctx, s))
	}
	return out, nil
}

func (h *tgHost) Session(ctx context.Context, id string) (telegram.Live, bool) {
	s, err := store.GetSession(ctx, h.d.store.DB(), id)
	if err != nil {
		return telegram.Live{}, false
	}
	return h.live(ctx, s), true
}

// live describes a session the way every Telegram message heads it.
func (h *tgHost) live(ctx context.Context, s store.Session) telegram.Live {
	det := h.d.sessionDetails(ctx, s)
	l := telegram.Live{ID: s.SessionID, Header: alerts.Header(det), Title: det.Title, Owned: s.Owned,
		Chat: s.Chat, LastAt: time.UnixMilli(max(s.WorkedAt, s.LastEventAt)), IdleEnded: s.IdleEndedAt > 0}
	if l.Title == "" {
		l.Title = det.Project
	}
	if h.d.mgr != nil {
		if a, ok := h.d.mgr.Get(s.SessionID); ok {
			l.Owned, l.Alive = true, true
			if _, waiting := h.d.mgr.PendingPermission(s.SessionID); waiting {
				l.Waiting = true
			} else if h.d.queue != nil {
				// The queue's reading of a turn: what the forward picker
				// calls working.
				w, _ := h.d.queue.waiting(ctx, a)
				l.Working = w == api.WaitingTurn
			}
		}
	}
	switch {
	case l.Waiting:
		l.State = "waiting for approval"
	case s.Status == "active":
		l.State = "active"
	case s.Status == "idle":
		l.State = "idle"
	}
	return l
}

// Type puts a message into a session's prompt and sends it the way the
// message queue does (typeMessage: a paste where the session takes one, the
// Enter on its own after a pause, and once more if the prompt still holds
// the text a moment later).
func (h *tgHost) Type(id, text string) error {
	if h.d.mgr == nil {
		return errors.New("this daemon cannot type into sessions")
	}
	if _, ok := h.d.mgr.Get(id); !ok {
		// Rule 7, said again below the bridge.
		return errors.New("caprock did not start this session, so it never types into it")
	}
	if _, waiting := h.d.mgr.PendingPermission(id); waiting {
		return errors.New("it is waiting for an approval; answer that first")
	}
	if _, err := typeMessage(h.d.mgr, id, text, queueTypeGap, nil); err != nil {
		return err
	}
	go func() {
		time.Sleep(queueConfirmAfter)
		if _, ok := h.d.mgr.Get(id); ok && confirmMessage(h.d.mgr, id, text) {
			h.d.log.Info("telegram: the prompt still held the message; pressed Enter again", "component", "telegram", "session_id", id)
		}
	}()
	return nil
}

// Answer goes through the same call as the app's card: the menu is read off
// the screen and the matching option's key pressed, never a digit typed
// blind (ADR-035) — the 0.78.2 fix for phantom rejections.
func (h *tgHost) Answer(id, promptID string, allow bool) error {
	if h.d.mgr == nil {
		return errors.New("this daemon cannot answer prompts")
	}
	choice := agents.PermissionDeny
	if allow {
		choice = agents.PermissionAllow
	}
	return h.d.mgr.AnswerPermission(id, promptID, choice)
}

func (h *tgHost) Stop(id string) error {
	if h.d.mgr == nil {
		return errors.New("this daemon cannot stop sessions")
	}
	return (&agentAdapter{m: h.d.mgr, d: h.d}).Signal(id, "kill")
}

func (h *tgHost) Projects(ctx context.Context) ([]telegram.Project, error) {
	ps, err := store.ListProjects(ctx, h.d.store.DB(), false)
	if err != nil {
		return nil, err
	}
	out := make([]telegram.Project, 0, len(ps))
	for _, p := range ps {
		out = append(out, telegram.Project{Name: p.Name, Root: p.Root})
	}
	return out, nil
}

func (h *tgHost) SpawnMode() string { return h.d.config().SpawnPermissionMode }

func (h *tgHost) Start(ctx context.Context, dir, prompt, mode string) (string, error) {
	if h.d.api == nil {
		return "", errors.New("this daemon cannot start sessions")
	}
	req := map[string]any{"cwd": dir, "agent": "claude"}
	if prompt != "" {
		req["prompt"] = prompt
	}
	if mode != "" {
		req["permission_mode"] = mode
	}
	id, err := h.d.api.StartSession(ctx, req)
	if errors.Is(err, api.ErrBypassConsent) {
		return "", telegram.ErrBypassConsent
	}
	if err == nil {
		h.d.log.Info("session started from Telegram", "component", "telegram", "session_id", id)
	}
	return id, err
}

// Forward sends a forward through the message queue, as the app's chat
// field does, marked as from Telegram (ADR-081). Rule 7 is the queue's: a
// session Caprock did not start, or that ended, is refused.
func (h *tgHost) Forward(ctx context.Context, id, text string) (int64, error) {
	if h.d.queue == nil {
		return 0, errors.New("this daemon cannot type into sessions")
	}
	res, err := h.d.queue.SendVia(ctx, id, text, viaTelegram)
	if err != nil {
		return 0, err
	}
	h.d.log.Info("telegram: a forward was sent to a session", "component", "telegram", "session_id", id, "queued", !res.Sent)
	if res.Queued != nil {
		return res.Queued.ID, nil
	}
	return 0, nil
}

// StartChat starts a new chat (ADR-071) with the forward as its first
// message, in mode; Bypass still needs the one-time consent of ADR-041.
func (h *tgHost) StartChat(ctx context.Context, text, mode string) (string, error) {
	if h.d.api == nil {
		return "", errors.New("this daemon cannot start sessions")
	}
	req := map[string]any{"chat": true, "agent": "claude", "prompt": text}
	if mode != "" {
		req["permission_mode"] = mode
	}
	id, err := h.d.api.StartSession(ctx, req)
	if errors.Is(err, api.ErrBypassConsent) {
		return "", telegram.ErrBypassConsent
	}
	if err != nil {
		return "", err
	}
	if h.d.queue != nil {
		h.d.queue.markVia(id, viaTelegram)
	}
	h.d.log.Info("chat started from a Telegram forward", "component", "telegram", "session_id", id)
	return id, nil
}

// Continue carries on a session Caprock ended for sitting idle (endidle.go)
// with text as its next message: --resume under its own id, in the mode it
// last ran in (the API's default for a continue), as the app's Continue does.
func (h *tgHost) Continue(ctx context.Context, id, text string) error {
	if h.d.api == nil {
		return errors.New("this daemon cannot start sessions")
	}
	s, err := store.GetSession(ctx, h.d.store.DB(), id)
	if err != nil {
		return err
	}
	if s.IdleEndedAt == 0 || s.Status != store.StatusEnded {
		return errors.New("it was not ended for sitting idle")
	}
	req := map[string]any{"cwd": s.Cwd, "resume": id, "fork": false, "prompt": text}
	if s.Agent != "" {
		req["agent"] = s.Agent
	}
	got, err := h.d.api.StartSession(ctx, req)
	if errors.Is(err, api.ErrBypassConsent) {
		return telegram.ErrBypassConsent
	}
	if err != nil {
		return err
	}
	if h.d.queue != nil {
		h.d.queue.markVia(got, viaTelegram)
	}
	h.d.log.Info("telegram: continued a session ended for idling", "component", "telegram", "session_id", got)
	return nil
}

// SaveFile keeps a forwarded photo, file or voice note where pasted files
// go, with the paste endpoint's checks.
func (h *tgHost) SaveFile(name, mimeType string, data []byte) (string, error) {
	return api.SaveFile(h.d.opt.DataDir, time.Now(), name, mimeType, data)
}

// viaTelegram marks a queued message and its prompt as forwarded from
// Telegram.
const viaTelegram = "telegram"

// queuedTyped is the queue typing a held message in: a forward's picker
// says it went.
func (d *Daemon) queuedTyped(m store.QueuedMessage) {
	if m.Via == viaTelegram && d.tg != nil {
		d.tg.QueuedSent(m.ID)
	}
}

// sessionDetails is what a message says about a session: its agent, project,
// title, folder and branch.
func (d *Daemon) sessionDetails(ctx context.Context, s store.Session) alerts.Details {
	det := alerts.Details{Agent: relay.AgentName(s.Agent), AgentKey: s.Agent, Title: api.Describe(ctx, d.store.DB(), s),
		Cwd: s.Cwd, Branch: s.GitBranch, Project: s.Project}
	if s.Agent == "grok" {
		det.Agent = "Grok Build"
	}
	det.Home, _ = os.UserHomeDir()
	return det
}

// alertMarkup is the buttons under an alert: Approve and Deny when the
// two-way chat is on and the prompt can be answered from here, Open on phone
// when the dashboard is reachable from one, and Mute.
func (d *Daemon) alertMarkup(a alerts.Alert, link, promptID string) *telegram.Markup {
	var rows [][]telegram.InlineButton
	if promptID != "" && !a.Question && d.tg != nil && d.tg.Active() {
		rows = append(rows, []telegram.InlineButton{{Text: "✅ Approve", CallbackData: "y"}, {Text: "✖️ Deny", CallbackData: "n"}})
	}
	var row []telegram.InlineButton
	if link != "" {
		row = append(row, telegram.InlineButton{Text: "Open on phone", URL: link})
	}
	row = append(row, telegram.InlineButton{Text: "🔕 Mute this session", CallbackData: "m"})
	return &telegram.Markup{InlineKeyboard: append(rows, row)}
}

// conversation is the bridge's own path for a session the owner talks to
// from Telegram: its question goes at once, every time, with buttons, and
// its reply goes whole the moment its turn ends — not after the alert's
// minute, which exists so that someone at the keyboard is not paged.
type conversation struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

// once reports whether key is new, forgetting keys older than an hour.
func (c *conversation) once(key string, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.seen == nil {
		c.seen = map[string]time.Time{}
	}
	for k, at := range c.seen {
		if now.Sub(at) > time.Hour {
			delete(c.seen, k)
		}
	}
	if _, ok := c.seen[key]; ok {
		return false
	}
	c.seen[key] = now
	return true
}

// conversationFresh is how old an event may be and still be sent: a
// transcript read again after a restart replays every Stop it holds.
const conversationFresh = 2 * time.Minute

// observeConversation sends what a session the owner talks to from Telegram
// said or asked. Returns true when it handled the event.
func (d *Daemon) observeConversation(ctx context.Context, ev event.Event) {
	if d.tg == nil || ev.SessionID == "" || !d.tg.Active() || d.tg.Muted(ev.SessionID) {
		return
	}
	now := d.rec.Now()
	if now.Sub(ev.Ts) > conversationFresh {
		return
	}
	var a alerts.Alert
	switch {
	case ev.Kind == event.KindPermissionPrompt:
		a = alerts.Alert{Kind: alerts.KindApproval, SessionID: ev.SessionID, Question: ev.Tool == "AskUserQuestion", Trigger: ev}
	case (ev.Kind == event.KindAgentStop || ev.Kind == event.KindThrottle) && !ev.Subagent():
		a = alerts.Alert{Kind: alerts.KindFinished, SessionID: ev.SessionID, Trigger: ev}
	default:
		return
	}
	// A conversation hears everything; a forward sent with Reply here on
	// hears only the answer to its own turn (ADR-081).
	if !d.tg.Conversing(ev.SessionID) && (a.Kind != alerts.KindFinished || !d.tg.TakeReplyOnce(ev.SessionID)) {
		return
	}
	if !d.talk.once(string(a.Kind)+"|"+ev.SessionID+"|"+ev.Ts.Format(time.RFC3339Nano), now) {
		return
	}
	go d.sendToTelegram(ctx, a, true)
}
