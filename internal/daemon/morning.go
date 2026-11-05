package daemon

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/morning"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/telegram"
)

// The Morning summary (ADR-092): one Telegram message a day through the
// owner's own bot, off until switched on. The daemon reads the figures —
// the mail the triage already marked, the sessions that ended, what waits
// — and internal/morning writes them; nothing here calls a model.

// morningTick is how often the daemon asks whether today's summary is due.
// A question rather than a timer, as the weekly report's: a Mac asleep at
// 08:00 fires no missed tick on waking, and the next minute's check sends
// it then, until noon (morning.Window).
const morningTick = time.Minute

// morningSendTimeout bounds one send, the outbox's queue included.
const morningSendTimeout = 45 * time.Second

// errMorningMuted is a summary held back by /mute all in the chat.
var errMorningMuted = errors.New("not sent: the chat is muted with /mute all")

// morningOutcome is the last send's outcome, for the settings row; restored
// from the store at start so a failure outlives a restart.
type morningOutcome struct {
	mu       sync.RWMutex
	lastErr  string
	lastSent int64
}

func (m *morningOutcome) get() (string, int64) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.lastErr, m.lastSent
}

// record keeps an outcome: sentMs is the scheduled send's time, 0 for a
// test send, which does not move "since the last summary".
func (d *Daemon) recordMorning(ctx context.Context, err error, sentMs int64) {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	d.morningState.mu.Lock()
	d.morningState.lastErr = msg
	if err == nil && sentMs > 0 {
		d.morningState.lastSent = sentMs
	}
	d.morningState.mu.Unlock()
	if d.store == nil {
		return
	}
	_ = d.store.SetMeta(ctx, store.MetaMorningLastError, msg)
	if err == nil && sentMs > 0 {
		_ = d.store.SetMeta(ctx, store.MetaMorningLastSent, strconv.FormatInt(sentMs, 10))
	}
}

func (d *Daemon) loadMorningState(ctx context.Context) {
	lastErr, _ := d.store.GetMeta(ctx, store.MetaMorningLastError)
	raw, _ := d.store.GetMeta(ctx, store.MetaMorningLastSent)
	sent, _ := strconv.ParseInt(raw, 10, 64)
	d.morningState.mu.Lock()
	d.morningState.lastErr, d.morningState.lastSent = lastErr, sent
	d.morningState.mu.Unlock()
}

func (d *Daemon) morningLoop(ctx context.Context) {
	d.loadMorningState(ctx)
	t := time.NewTicker(morningTick)
	defer t.Stop()
	d.morningOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.morningOnce(ctx)
		}
	}
}

// morningOnce sends today's summary when it is due: switched on, a bot and
// a chat set up, not sent today, and inside today's window. The day is
// marked before the send, as the weekly report's week is: a failing network
// costs one morning's message, never sends five.
func (d *Daemon) morningOnce(ctx context.Context) {
	cfg := d.config()
	if !cfg.MorningSummaryOn() || !d.botConfigured() {
		return
	}
	now := d.rec.Now().In(d.location())
	last, _ := d.store.GetMeta(ctx, store.MetaMorningDay)
	if !morning.Due(true, now, cfg.MorningSummaryAt, last) {
		return
	}
	if err := d.store.SetMeta(ctx, store.MetaMorningDay, morning.Day(now)); err != nil {
		d.log.Warn("morning summary: could not record the day", "component", "morning", "err", err)
		return
	}
	err := d.sendMorning(ctx, now)
	if err != nil {
		d.log.Warn("morning summary: not sent", "component", "morning", "err", err)
		d.recordMorning(ctx, err, 0)
		return
	}
	d.log.Info("morning summary sent", "component", "morning", "day", morning.Day(now))
	d.recordMorning(ctx, nil, now.UnixMilli())
}

// SendMorningNow implements api.MorningSender: the summary as it would read
// now, sent at once whether or not it is switched on. Today's marker is not
// touched, so the scheduled one still goes.
func (d *Daemon) SendMorningNow(ctx context.Context) error {
	if !d.botConfigured() {
		return errors.New("no Telegram bot is set up: Settings → Telegram")
	}
	err := d.sendMorning(ctx, d.rec.Now().In(d.location()))
	d.recordMorning(ctx, err, 0)
	return err
}

// buildMorning reads what the summary says, since the last one (a day back
// at most). A part that cannot be read is left out rather than holding the
// rest back.
func (d *Daemon) buildMorning(ctx context.Context, now time.Time) morning.Summary {
	_, lastSent := d.morningState.get()
	since := morning.Since(now, lastSent)
	sum := morning.Summary{Now: now}
	if d.mail != nil {
		if dg, ok := d.mail.Digest(ctx, since, morning.MailMax); ok {
			m := &morning.Mail{Important: dg.Important, Total: dg.Total}
			for _, it := range dg.Items {
				m.Items = append(m.Items, morning.MailItem{Sender: it.Sender, Subject: it.Subject})
			}
			sum.Mail = m
		}
	}
	if ps, err := store.FinishedSince(ctx, d.store.DB(), morning.Day(since.In(now.Location())), since.UnixMilli(), now.UnixMilli()); err == nil {
		for _, p := range ps {
			sum.Projects = append(sum.Projects, morning.Project{Name: p.Project, Finished: p.Finished, AtLimit: p.AtLimit, Errored: p.Errored})
		}
	} else {
		d.log.Warn("morning summary: could not read the sessions", "component", "morning", "err", err)
	}
	if d.api != nil {
		if ws, err := d.api.WaitingSessions(ctx); err == nil {
			for _, w := range ws {
				sum.Waiting = append(sum.Waiting, morning.Waiting{Project: w.Project, Title: w.Title, Reason: w.Reason})
			}
		}
	}
	if b, _ := d.hiveState(); b != nil {
		if v, err := b.Approvals(ctx); err == nil {
			if rows, ok := v.([]store.TaskRow); ok {
				sum.Approvals = len(rows)
			}
		}
	}
	return sum
}

// morningBase is the phone's page the buttons open: m.caprock.dev (or the
// owner's own) while access from anywhere is on, else the dashboard's
// address on the Wi-Fi or Tailscale when phone access is on, else nothing —
// and then the message has no buttons.
// The remote settings are the ones the daemon read at start (never loaded
// here: a load with none on disk writes new keys).
func (d *Daemon) morningBase() string {
	d.mu.Lock()
	set := d.remoteSet
	d.mu.Unlock()
	if set != nil && set.Enabled {
		return set.AppURL()
	}
	return d.phoneURL()
}

// sendMorning builds the summary and sends it to the paired chat: through
// the bridge's outbox when it runs, with its buttons; else straight to the
// bot, as the alerts do.
func (d *Daemon) sendMorning(ctx context.Context, now time.Time) error {
	if d.tg != nil && d.tg.Store.Get().MuteAll {
		return errMorningMuted
	}
	ctx, cancel := context.WithTimeout(ctx, morningSendTimeout)
	defer cancel()
	sum := d.buildMorning(ctx, now)
	text := morning.Message(sum)
	if d.tg == nil {
		cfg := d.config()
		return d.sender().SendFormatted(ctx, cfg.ReportBotToken, cfg.ReportChatID, text, "HTML")
	}
	out := telegram.Out{Text: text, ParseMode: "HTML"}
	if bs := morning.Buttons(sum, d.morningBase()); len(bs) > 0 {
		row := make([]telegram.InlineButton, 0, len(bs))
		for _, b := range bs {
			row = append(row, telegram.InlineButton{Text: b.Text, URL: b.URL})
		}
		out.Markup = &telegram.Markup{InlineKeyboard: [][]telegram.InlineButton{row}}
	}
	_, err := d.tg.Out.Send(ctx, out)
	return err
}
