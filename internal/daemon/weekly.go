package daemon

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/license"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/weekly"
)

// reportHour is when a week's report is sent, local time. Monday morning, but
// see weeklyLoop: this is a "not before" rather than an appointment.
const reportHour = 9

// weeklyCheck is how often the daemon asks whether a report is due. Hourly
// rather than weekly on purpose — see weeklyLoop.
const weeklyCheck = time.Hour

// reportState is the small bit of mutable state the feature needs: the last
// failure, so a message that never arrived can be explained on screen, and the
// last success, so the panel can say when.
type reportState struct {
	mu       sync.RWMutex
	lastErr  string
	lastSent int64
}

func (d *Daemon) reportLastError() string {
	d.report.mu.RLock()
	defer d.report.mu.RUnlock()
	return d.report.lastErr
}

func (d *Daemon) reportLastSent() int64 {
	d.report.mu.RLock()
	defer d.report.mu.RUnlock()
	return d.report.lastSent
}

// weeklyLoop sends the report when a week has gone by, not when a timer fires.
//
// A ticker set for Monday 09:00 sends to nobody: the laptop is closed at the
// weekend, macOS does not fire missed ticks on wake, and the next tick is a
// week later. So this asks a question instead — is the ISO week of the last
// report we sent behind the current one, and is it past the send hour — and
// answers it every hour. A machine opened on Wednesday gets Monday's report on
// Wednesday, labelled with the week it covers, which is the honest outcome.
//
// The marker is in the store rather than in memory, or a restart would send a
// second copy.
func (d *Daemon) weeklyLoop(ctx context.Context) {
	t := time.NewTicker(weeklyCheck)
	defer t.Stop()
	d.weeklyOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.weeklyOnce(ctx)
		}
	}
}

func (d *Daemon) weeklyOnce(ctx context.Context) {
	cfg := d.config()
	// No bot, no feature: this is the opt-in, and with nothing configured
	// there is no timer to disable and nothing that could be sent.
	if strings.TrimSpace(cfg.ReportBotToken) == "" || strings.TrimSpace(cfg.ReportChatID) == "" {
		return
	}
	// Paid, and checked here rather than only in the UI: this reaches the
	// network on a schedule, which is the boundary ADR-023 drew for
	// server-side gates.
	if !license.Parse(cfg.LicenseKey, time.Now()).Active {
		return
	}

	now := time.Now()
	week := isoWeek(now)
	sent, _ := d.store.GetMeta(ctx, store.MetaReportWeek)
	if sent == week {
		return // already sent for this week
	}
	// Before the send hour on Monday, there is nothing to report yet: the week
	// only just started. After it, or any later day, send.
	if now.Weekday() == time.Monday && now.Hour() < reportHour {
		return
	}

	rep, err := d.buildWeekly(ctx, now)
	if err != nil {
		d.log.Warn("weekly report: could not build", "component", "report", "err", err)
		return
	}

	// The marker is written BEFORE the send, so a failing network cannot make
	// the daemon retry every hour and eventually deliver five copies. A missed
	// week is a smaller harm than a phone buzzing all afternoon, and the error
	// is surfaced on the settings screen either way.
	if err := d.store.SetMeta(ctx, store.MetaReportWeek, week); err != nil {
		d.log.Warn("weekly report: could not record the week", "component", "report", "err", err)
		return
	}

	msg := weekly.Message(rep, d.reportBasis())
	sender := &weekly.Sender{}
	err = sender.Send(ctx, cfg.ReportBotToken, cfg.ReportChatID, msg)

	d.report.mu.Lock()
	if err != nil {
		d.report.lastErr = err.Error()
		d.log.Warn("weekly report: send failed", "component", "report", "err", err)
	} else {
		d.report.lastErr = ""
		d.report.lastSent = time.Now().UnixMilli()
		d.log.Info("weekly report sent", "component", "report", "week", week)
	}
	d.report.mu.Unlock()
}

// buildWeekly reads the daily rollups the report is computed from.
//
// daily_stats is already keyed (day, project, model), which is exactly the
// grain this needs, and reading it costs a fraction of scanning events — the
// same reason History uses it.
func (d *Daemon) buildWeekly(ctx context.Context, now time.Time) (weekly.Report, error) {
	loc := d.location()
	end := startOfDay(now, loc)
	// Enough history for the week plus its baseline.
	from := end.AddDate(0, 0, -7*(weekly.BaselineWeeks+1))

	rows, err := store.Daily(ctx, d.store.DB(), from.Format("2006-01-02"))
	if err != nil {
		return weekly.Report{}, err
	}
	days := make([]weekly.Day, 0, len(rows))
	for _, r := range rows {
		days = append(days, weekly.Day{
			Day: r.Day, Project: r.Project, Model: r.Model,
			CostUSD: r.CostUSD, Tokens: r.TokensTotal,
		})
	}
	return weekly.Build(days, end), nil
}

// reportBasis is the caveat that travels with the figures, in the message
// itself rather than only on a screen the reader is not looking at (rule 6).
func (d *Daemon) reportBasis() string {
	return "At API list prices — what your tokens would cost, not a bill."
}

// isoWeek is the marker's format: "2026-W36". ISO rather than "week of the
// year" because ISO weeks start on Monday, which is when the report is for.
func isoWeek(t time.Time) string {
	y, w := t.ISOWeek()
	return fmt.Sprintf("%d-W%02d", y, w)
}
