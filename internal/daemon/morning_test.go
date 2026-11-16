package daemon

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/remote"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/telegram"
)

// morningDaemon is the bridge against a fake bot, with the daemon's clock
// at now (UTC).
func morningDaemon(t *testing.T, cfg config.Config, now *time.Time) (*Daemon, func() int) {
	t.Helper()
	d, bot := bridgeDaemon(t, cfg)
	d.rec.Now = func() time.Time { return *now }
	return d, func() int { return len(bot.Messages()) }
}

func on() *bool { v := true; return &v }

// Off until switched on: a bot set up for alerts sends no summary.
func TestMorningSummaryIsOffByDefault(t *testing.T) {
	now := time.Date(2026, 11, 5, 8, 30, 0, 0, time.UTC)
	d, sent := morningDaemon(t, config.Config{}, &now)
	d.morningOnce(context.Background())
	time.Sleep(50 * time.Millisecond)
	if n := sent(); n != 0 {
		t.Fatalf("sent %d while off", n)
	}
	if day, _ := d.store.GetMeta(context.Background(), store.MetaMorningDay); day != "" {
		t.Fatalf("marked %q while off", day)
	}
}

// Once a day, never twice — not on the next tick, not after a restart that
// forgets everything in memory.
func TestMorningSummaryGoesOncePerDay(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 11, 5, 8, 0, 0, 0, time.UTC)
	d, sent := morningDaemon(t, config.Config{MorningSummary: on()}, &now)
	d.morningOnce(ctx)
	waitFor(t, "the summary", func() bool { return sent() == 1 })
	now = now.Add(time.Hour)
	d.morningOnce(ctx)
	d.morningState = morningOutcome{} // a restart
	d.loadMorningState(ctx)
	d.morningOnce(ctx)
	time.Sleep(50 * time.Millisecond)
	if n := sent(); n != 1 {
		t.Fatalf("sent %d in one day", n)
	}
	if _, last := d.morningState.get(); last != time.Date(2026, 11, 5, 8, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("last sent %d not kept across the restart", last)
	}
	// The next morning it goes again.
	now = time.Date(2026, 11, 6, 8, 1, 0, 0, time.UTC)
	d.morningOnce(ctx)
	waitFor(t, "the next morning's", func() bool { return sent() == 2 })
}

// Asleep at 08:00: sent on waking that morning; not once the morning is
// over.
func TestMorningSummaryAfterSleep(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 11, 5, 13, 0, 0, 0, time.UTC)
	d, sent := morningDaemon(t, config.Config{MorningSummary: on()}, &now)
	d.morningOnce(ctx)
	time.Sleep(50 * time.Millisecond)
	if sent() != 0 {
		t.Fatal("sent in the afternoon")
	}
	now = time.Date(2026, 11, 6, 10, 40, 0, 0, time.UTC)
	d.morningOnce(ctx)
	waitFor(t, "the late-morning summary", func() bool { return sent() == 1 })
}

// What it says comes from the store, and the buttons open the phone's page
// only while access from anywhere is on.
func TestMorningSummaryTextAndButtons(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 11, 5, 8, 0, 0, 0, time.UTC)
	d, bot := bridgeDaemon(t, config.Config{MorningSummary: on()})
	d.rec.Now = func() time.Time { return now }
	db := d.store.DB()
	if err := store.UpsertSession(ctx, db, "s1", store.SessionPatch{Agent: "claude", Cwd: "/w/caprock", StartedAt: 1, LastEventAt: now.Add(-3 * time.Hour).UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE sessions SET project = 'caprock', status = 'ended', exit_code = 1 WHERE session_id = 's1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO daily_sessions(day, project, session_id) VALUES('2026-11-05', 'caprock', 's1')`); err != nil {
		t.Fatal(err)
	}
	if err := d.SendMorningNow(ctx); err != nil {
		t.Fatal(err)
	}
	m := bot.Messages()[0]
	want := "<b>Good morning · Thursday</b>\n\n<b>Agents overnight</b>\n• caprock — 1 session finished, 1 exited with an error"
	if m.Text != want || m.ParseMode != "HTML" || len(m.Buttons) != 0 {
		t.Fatalf("text %q mode %q buttons %v", m.Text, m.ParseMode, m.Buttons)
	}
	// A test send does not count as today's.
	if day, _ := d.store.GetMeta(ctx, store.MetaMorningDay); day != "" {
		t.Fatalf("the test marked the day %q", day)
	}
	d.mu.Lock()
	d.remoteSet = &remote.Settings{Enabled: true}
	d.mu.Unlock()
	d.morningOnce(ctx)
	waitFor(t, "the scheduled summary", func() bool { return len(bot.Messages()) == 2 })
	if b := strings.Join(bot.Messages()[1].Buttons, " "); b != "url:https://m.caprock.dev/#/ url:https://m.caprock.dev/#/history" {
		t.Fatalf("buttons %q", b)
	}
}

// /mute all holds the summary back, and the settings row says why.
func TestMorningSummaryRespectsMuteAll(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 11, 5, 8, 0, 0, 0, time.UTC)
	d, sent := morningDaemon(t, config.Config{MorningSummary: on()}, &now)
	if err := d.tg.Store.Update(func(st *telegram.State) { st.MuteAll = true }); err != nil {
		t.Fatal(err)
	}
	d.morningOnce(ctx)
	time.Sleep(50 * time.Millisecond)
	if sent() != 0 {
		t.Fatal("sent while muted")
	}
	if e, _ := d.morningState.get(); e != errMorningMuted.Error() {
		t.Fatalf("last error %q", e)
	}
}

// The switch is off and the time 08:00 until chosen; an unchanged default is
// not written down, a chosen time survives a restart.
func TestMorningSummarySettingsPersist(t *testing.T) {
	dir := t.TempDir()
	d := &Daemon{log: quietLog(), opt: Options{DataDir: dir}, baseCtx: context.Background()}
	a := &settingsAdapter{d: d}
	if g := a.Get(); g.MorningSummary || g.MorningSummaryAt != "08:00" {
		t.Fatalf("defaults: %v %q", g.MorningSummary, g.MorningSummaryAt)
	}
	if err := a.Set(a.Get()); err != nil {
		t.Fatal(err)
	}
	if d.opt.Config.MorningSummaryAt != "" || d.opt.Config.MorningSummaryOn() {
		t.Fatalf("an unchanged default was stored: %q", d.opt.Config.MorningSummaryAt)
	}
	in := a.Get()
	in.MorningSummary, in.MorningSummaryAt = true, "07:15"
	if err := a.Set(in); err != nil {
		t.Fatal(err)
	}
	saved, err := config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !saved.MorningSummaryOn() || saved.MorningSummaryAt != "07:15" {
		t.Fatalf("not persisted: %v %q", saved.MorningSummaryOn(), saved.MorningSummaryAt)
	}
}
