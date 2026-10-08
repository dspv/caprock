package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/alerts"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/relay"
	"github.com/dspv/caprock/internal/store"
)

// alertTick is how often pending "finished" alerts are checked. Their minute
// is a floor, not an appointment, so a few seconds late is fine.
const alertTick = 5 * time.Second

// alertSendTimeout bounds one alert's delivery.
const alertSendTimeout = 30 * time.Second

// phoneAlertState is what the settings screen shows about phone alerts: the
// last failure and the last success. In memory only — an alert is a moment,
// and the panel's test button answers the "does it work" question at once.
type phoneAlertState struct {
	mu       sync.RWMutex
	lastErr  string
	lastSent int64
}

func (s *phoneAlertState) record(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		s.lastErr = err.Error()
		return
	}
	s.lastErr = ""
	s.lastSent = time.Now().UnixMilli()
}

func (s *phoneAlertState) get() (string, int64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastErr, s.lastSent
}

// botConfigured reports whether the owner has set up a Telegram bot. Shared
// with the weekly report; unlike it, alerts are free (ADR-036).
func (d *Daemon) botConfigured() bool {
	cfg := d.config()
	return strings.TrimSpace(cfg.ReportBotToken) != "" && strings.TrimSpace(cfg.ReportChatID) != ""
}

// alertEnabled is the switch for one kind, read per event so a change in
// Settings applies at once.
func (d *Daemon) alertEnabled(k alerts.Kind) bool {
	if !d.botConfigured() {
		return false
	}
	cfg := d.config()
	if k == alerts.KindApproval {
		return cfg.AlertApprovalOn()
	}
	return cfg.AlertFinishedOn()
}

// notifyEnabled is the desktop app's switch for one kind (WP-09), apart from
// Telegram's and read per event like it.
func (d *Daemon) notifyEnabled(k alerts.Kind) bool {
	cfg := d.config()
	if k == alerts.KindApproval {
		return cfg.NotifyApprovalOn()
	}
	return cfg.NotifyFinishedOn()
}

// alertLoop watches every stored event, from every agent and source, and
// sends what the rules decide. With no bot configured nothing is sent and
// nothing leaves the machine; the rules still track state, so configuring one
// mid-session starts from the truth.
//
// Telegram and the app's notify frame are two senders of one decision: the
// rules run once, a kind is decided while either sender wants it, and the
// cooldown and hourly cap count it once for both (.ai/21-app.md
// § Notifications).
func (d *Daemon) alertLoop(ctx context.Context, sub *bus.Subscriber) {
	defer sub.Unsubscribe()
	rules := alerts.New(func(k alerts.Kind) bool { return d.alertEnabled(k) || d.notifyEnabled(k) })
	t := time.NewTicker(alertTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case f, ok := <-sub.C:
			if !ok {
				return
			}
			ev, isEvent := f.Data.(event.Event)
			if f.Type != bus.FrameEvent || !isEvent {
				continue
			}
			for _, a := range rules.Observe(ev, d.rec.Now()) {
				go d.deliverAlert(ctx, a)
			}
		case <-t.C:
			for _, a := range rules.Due(d.rec.Now()) {
				go d.deliverAlert(ctx, a)
			}
		}
	}
}

// deliverAlert hands one decision to each sender switched on for its kind:
// the notify frame first, since it stays on the machine and is quick.
func (d *Daemon) deliverAlert(ctx context.Context, a alerts.Alert) {
	if d.notifyEnabled(a.Kind) {
		d.publishNotify(ctx, a)
	}
	if d.alertEnabled(a.Kind) {
		d.sendAlert(ctx, a)
	}
}

// publishNotify puts the alert on /v1/live as a notify frame, numbered and
// replayed like any frame. An approval in an owned session carries the
// waiting prompt's id, so an answer from the notification is refused once
// that prompt is gone (ADR-035).
func (d *Daemon) publishNotify(ctx context.Context, a alerts.Alert) {
	det := d.alertDetails(ctx, a)
	n := alerts.Notify(a, det, d.waitingPrompt(a))
	d.bus.Publish(bus.Frame{Type: bus.FrameNotify, Data: n})
	d.log.Info("notify frame published", "component", "alerts", "kind", n.Kind, "session_id", a.SessionID, "prompt", n.PromptID != "")
}

// waitingPrompt is the id of the prompt an owned session waits on, for an
// approval alert; "" otherwise. The hook sets the prompt before the event is
// stored, so it is there when the alert is decided. With more than one
// outstanding it is "" too: which dialog the terminal shows is unknown, so the
// notification offers no answer at all (ADR-035, amended 2026-10-09).
func (d *Daemon) waitingPrompt(a alerts.Alert) string {
	if a.Kind != alerts.KindApproval || d.mgr == nil {
		return ""
	}
	return answerablePrompt(d.mgr.PendingPermission(a.SessionID))
}

// answerablePrompt is the id a notification may answer: the prompt's, when it
// is the only one outstanding.
func answerablePrompt(p *agents.Permission, ok bool) string {
	if !ok || p == nil || p.Queued > 0 {
		return ""
	}
	return p.ID
}

// sendAlert renders one alert and delivers it. Failures are logged and kept
// for the settings screen; an alert is never retried, because a late
// "waiting for approval" is worse than none.
func (d *Daemon) sendAlert(ctx context.Context, a alerts.Alert) {
	ctx, cancel := context.WithTimeout(ctx, alertSendTimeout)
	defer cancel()
	msg := alerts.Message(a, d.alertDetails(ctx, a))
	cfg := d.config()
	err := d.sender().SendFormatted(ctx, cfg.ReportBotToken, cfg.ReportChatID, msg, alerts.ParseMode)
	d.phone.record(err)
	if err != nil {
		d.log.Warn("phone alert: send failed", "component", "alerts", "kind", a.Kind, "session_id", a.SessionID, "err", err)
		return
	}
	d.log.Info("phone alert sent", "component", "alerts", "kind", a.Kind, "session_id", a.SessionID)
}

// runSlack widens a run's end past its Stop: the transcript writes the last
// turn with its own clock, a moment either side of the hook's.
const runSlack = 2 * time.Second

// alertDetails gathers what an alert says about its session. A failed read
// leaves a field empty rather than holding the alert back.
func (d *Daemon) alertDetails(ctx context.Context, a alerts.Alert) alerts.Details {
	det := alerts.Details{Agent: relay.AgentName(""), Link: d.sessionLink(a.SessionID)}
	det.Home, _ = os.UserHomeDir()
	q := d.store.DB()
	s, err := store.GetSession(ctx, q, a.SessionID)
	if err == nil {
		det.Title, det.Cwd, det.Branch, det.Agent = api.Describe(ctx, q, s), s.Cwd, s.GitBranch, relay.AgentName(s.Agent)
		det.Project = s.Project
	}
	if a.Kind != alerts.KindFinished {
		return det
	}
	end := a.Trigger.Ts
	if end.IsZero() {
		end = d.rec.Now()
	}
	if run, err := store.LastRun(ctx, q, a.SessionID, end.Add(runSlack).UnixMilli()); err == nil {
		det.CostUSD, det.Tools, det.Files = run.CostUSD, run.ToolCalls, run.Files
		if run.PromptAt > 0 {
			det.Run = end.Sub(time.UnixMilli(run.PromptAt))
		} else if s.StartedAt > 0 {
			det.Run = end.Sub(time.UnixMilli(s.StartedAt))
		}
	}
	if d.config().AlertReplyOn() {
		det.Reply = d.finalReply(ctx, a)
	}
	return det
}

// finalReply is the agent's last reply: what the Stop hook carries, or the
// newest main-thread prose stored when the hook does not (older Claude Code,
// a failed turn).
func (d *Daemon) finalReply(ctx context.Context, a alerts.Alert) string {
	var p struct {
		LastAssistantMessage string `json:"last_assistant_message"`
	}
	if json.Unmarshal(a.Trigger.Payload, &p) == nil && strings.TrimSpace(p.LastAssistantMessage) != "" {
		return p.LastAssistantMessage
	}
	if a.Trigger.Kind == event.KindThrottle {
		return "" // the turn failed; its last prose is not its reply
	}
	notes, err := store.SessionNotes(ctx, d.store.DB(), a.SessionID, 1)
	if err != nil || len(notes) == 0 {
		return ""
	}
	return notes[0].Text
}

// sessionLink is the session's page on the dashboard at the address a phone
// can reach — the LAN or Tailscale one — or "" when phone access is off and
// the only address is loopback, which would open nothing on a phone.
func (d *Daemon) sessionLink(id string) string {
	base := d.phoneURL()
	if base == "" {
		return ""
	}
	if id == "" {
		return base + "/"
	}
	return base + "/#/session/" + url.PathEscape(id)
}

func (d *Daemon) phoneURL() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.lanURL
}

// SendAlertCheck sends a test alert now, so whoever set up the bot sees what
// an alert looks like without waiting for a session to need them.
func (d *Daemon) SendAlertCheck(ctx context.Context) error {
	if !d.botConfigured() {
		return fmt.Errorf("no bot configured")
	}
	cfg := d.config()
	err := d.sender().SendFormatted(ctx, cfg.ReportBotToken, cfg.ReportChatID, alerts.CheckMessage(d.sessionLink("")), alerts.ParseMode)
	d.phone.record(err)
	return err
}
