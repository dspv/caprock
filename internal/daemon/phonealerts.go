package daemon

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/alerts"
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

// alertLoop watches every stored event, from every agent and source, and
// sends what the rules decide. With no bot configured nothing is sent and
// nothing leaves the machine; the rules still track state, so configuring one
// mid-session starts from the truth.
func (d *Daemon) alertLoop(ctx context.Context, sub *bus.Subscriber) {
	defer sub.Unsubscribe()
	rules := alerts.New(d.alertEnabled)
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
				go d.sendAlert(ctx, a)
			}
		case <-t.C:
			for _, a := range rules.Due(d.rec.Now()) {
				go d.sendAlert(ctx, a)
			}
		}
	}
}

// sendAlert renders one alert and delivers it. Failures are logged and kept
// for the settings screen; an alert is never retried, because a late
// "waiting for approval" is worse than none.
func (d *Daemon) sendAlert(ctx context.Context, a alerts.Alert) {
	ctx, cancel := context.WithTimeout(ctx, alertSendTimeout)
	defer cancel()
	project, agent := "", relay.AgentName("")
	if s, err := store.GetSession(ctx, d.store.DB(), a.SessionID); err == nil {
		project, agent = s.Project, relay.AgentName(s.Agent)
	}
	msg := alerts.Message(a, project, agent, d.sessionLink(a.SessionID))
	cfg := d.config()
	err := d.sender().Send(ctx, cfg.ReportBotToken, cfg.ReportChatID, msg)
	d.phone.record(err)
	if err != nil {
		d.log.Warn("phone alert: send failed", "component", "alerts", "kind", a.Kind, "session_id", a.SessionID, "err", err)
		return
	}
	d.log.Info("phone alert sent", "component", "alerts", "kind", a.Kind, "session_id", a.SessionID)
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
	err := d.sender().Send(ctx, cfg.ReportBotToken, cfg.ReportChatID, alerts.CheckMessage(d.sessionLink("")))
	d.phone.record(err)
	return err
}
