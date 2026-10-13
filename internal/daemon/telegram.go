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

// SaveBot keeps the token in the secret store, never in config.json.
func (h *tgHost) SaveBot(token string) error {
	token = strings.TrimSpace(token)
	if err := h.d.putSecret(context.Background(), telegramSecret, token); err != nil {
		return err
	}
	return h.saveConfig(func(c *config.Config) { applySecret(c, telegramSecret, token) })
}

func (h *tgHost) SaveChat(chat string) error {
	return h.saveConfig(func(c *config.Config) { c.ReportChatID = strings.TrimSpace(chat) })
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
	l := telegram.Live{ID: s.SessionID, Header: alerts.Header(det), Title: det.Title, Owned: s.Owned}
	if l.Title == "" {
		l.Title = det.Project
	}
	if h.d.mgr != nil {
		if _, ok := h.d.mgr.Get(s.SessionID); ok {
			l.Owned, l.Alive = true, true
			if _, waiting := h.d.mgr.PendingPermission(s.SessionID); waiting {
				l.Waiting = true
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

// typeGap is the pause between a message and the Enter that sends it: a CR
// in the same write can be read as part of a paste (as typeWhenReady).
const typeGap = 200 * time.Millisecond

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
	body := strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\n", "\x1b\r")
	if err := h.d.mgr.Input(id, []byte(body)); err != nil {
		return err
	}
	time.Sleep(typeGap)
	return h.d.mgr.Input(id, []byte("\r"))
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
	if d.tg == nil || ev.SessionID == "" || !d.tg.Active() || !d.tg.Conversing(ev.SessionID) || d.tg.Muted(ev.SessionID) {
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
	if !d.talk.once(string(a.Kind)+"|"+ev.SessionID+"|"+ev.Ts.Format(time.RFC3339Nano), now) {
		return
	}
	go d.sendToTelegram(ctx, a, true)
}
