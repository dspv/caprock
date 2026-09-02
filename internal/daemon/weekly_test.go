package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/license"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// The marker is what stops a restart from sending a second copy of a message
// somebody already got on their phone. cap.Guard keeps its equivalent in
// memory and re-fires after a restart, which is tolerable for a cap and not
// for this.
func TestTheSentWeekIsRemembered(t *testing.T) {
	ctx := context.Background()
	st := memStore(t)

	week := isoWeek(time.Date(2026, 9, 7, 10, 0, 0, 0, time.UTC))
	if err := st.SetMeta(ctx, store.MetaReportWeek, week); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetMeta(ctx, store.MetaReportWeek)
	if err != nil || got != week {
		t.Fatalf("marker did not survive: %q %v", got, err)
	}
}

// A laptop closed on Friday and opened on Wednesday must still get the report.
// A ticker anchored to Monday 09:00 fires for nobody in that case, which is
// the ordinary case rather than an edge one.
func TestIsoWeekIdentifiesTheWeekNotTheDay(t *testing.T) {
	monday := time.Date(2026, 9, 7, 9, 0, 0, 0, time.UTC)
	wednesday := time.Date(2026, 9, 9, 16, 0, 0, 0, time.UTC)
	sunday := time.Date(2026, 9, 13, 23, 0, 0, 0, time.UTC)

	if isoWeek(monday) != isoWeek(wednesday) || isoWeek(monday) != isoWeek(sunday) {
		t.Errorf("days of one week produced different markers: %s %s %s",
			isoWeek(monday), isoWeek(wednesday), isoWeek(sunday))
	}
	// And the next week is a different marker, or the report would never send
	// again.
	if isoWeek(monday) == isoWeek(monday.AddDate(0, 0, 7)) {
		t.Error("the following week shares a marker with this one")
	}
}

func TestIsoWeekFormat(t *testing.T) {
	got := isoWeek(time.Date(2026, 1, 5, 12, 0, 0, 0, time.UTC))
	if got != "2026-W02" {
		t.Errorf("isoWeek = %q, want 2026-W02", got)
	}
}

// With nothing configured there is no timer and nothing to disable: the
// absence of a bot IS the off switch.
func TestNoBotMeansNoWork(t *testing.T) {
	d := &Daemon{log: quietLog(), store: memStore(t)}
	// Would panic on a nil store read if it got past the configuration check.
	d.weeklyOnce(context.Background())
}

// A weekly message that stops arriving is the failure mode this feature has:
// nobody notices an absence. The reason it stopped therefore has to outlive a
// restart — because restarting is precisely what somebody does when a feature
// seems broken, and an in-memory error is erased by the act of investigating
// it.
func TestWhyAReportFailedSurvivesARestart(t *testing.T) {
	ctx := context.Background()
	st := memStore(t)

	// What a failed send leaves behind.
	if err := st.SetMeta(ctx, store.MetaReportLastError, "chat not found"); err != nil {
		t.Fatal(err)
	}

	// A fresh daemon over the same store: the restart.
	d := &Daemon{store: st}
	d.loadReportState(ctx)

	if got := d.reportLastError(); got != "chat not found" {
		t.Errorf("last error after a restart = %q, want Telegram's own words back", got)
	}
}

func TestASuccessfulSendClearsTheOldError(t *testing.T) {
	// An error left on screen after the next report arrived would send someone
	// hunting a problem they no longer have.
	ctx := context.Background()
	st := memStore(t)

	if err := st.SetMeta(ctx, store.MetaReportLastError, "bot was blocked by the user"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetMeta(ctx, store.MetaReportLastError, ""); err != nil {
		t.Fatal(err)
	}
	if err := st.SetMeta(ctx, store.MetaReportLastSent, "1788350000000"); err != nil {
		t.Fatal(err)
	}

	d := &Daemon{store: st}
	d.loadReportState(ctx)

	if got := d.reportLastError(); got != "" {
		t.Errorf("a stale error survived a successful send: %q", got)
	}
	if got := d.reportLastSent(); got != 1788350000000 {
		t.Errorf("last sent = %d, want the recorded timestamp", got)
	}
}

// Nothing recorded is the normal first-run state and must not look like a
// failure.
func TestNoHistoryIsNotAnError(t *testing.T) {
	ctx := context.Background()
	d := &Daemon{store: memStore(t)}
	d.loadReportState(ctx)
	if got := d.reportLastError(); got != "" {
		t.Errorf("a daemon that never sent anything reports %q", got)
	}
	if got := d.reportLastSent(); got != 0 {
		t.Errorf("last sent = %d, want 0", got)
	}
}

// telegramStub stands in for api.telegram.org. It records what was actually
// delivered, so a test can tell "the daemon decided to send" from "the daemon
// decided to stay quiet" — the distinction the whole schedule is made of — and
// it keeps the suite off the network (rule 4).
type telegramStub struct {
	mu   sync.Mutex
	sent []string
	fail string // non-empty ⇒ answer like Telegram refusing the message
}

func (s *telegramStub) start(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Text string `json:"text"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		s.mu.Lock()
		s.sent = append(s.sent, in.Text)
		fail := s.fail
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if fail != "" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "description": fail})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func (s *telegramStub) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sent)
}

func (s *telegramStub) last() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.sent) == 0 {
		return ""
	}
	return s.sent[len(s.sent)-1]
}

// activeKey is a licence that is valid today. The date in a key is the last day
// it covers, so a key dated in the future is an active one.
func activeKey() string {
	return license.Prefix + time.Now().AddDate(0, 0, 30).Format("2006-01-02") + "-test"
}

// expiredKey is a licence whose grace period is long gone.
func expiredKey() string {
	return license.Prefix + time.Now().AddDate(0, 0, -365).Format("2006-01-02") + "-test"
}

// reportDaemon is a daemon wired for the report and nothing else: a store, a
// bot, and a Telegram that is really a test server.
func reportDaemon(t *testing.T, host string, cfg config.Config) (*Daemon, *store.Store) {
	t.Helper()
	st := memStore(t)
	rec := rollup.New(st, embeddedTable(t), bus.New(), quietLog())
	rec.Location = time.UTC
	d := &Daemon{log: quietLog(), store: st, rec: rec, opt: Options{Config: cfg}}
	d.report.base = host
	return d, st
}

// The paid gate lives in the daemon, not only in the UI, because this is the
// one feature that reaches the network on a schedule with nobody watching
// (ADR-023). A UI-only gate would keep sending to anyone whose licence lapsed —
// a free tier quietly getting a paid feature forever, and one no screen would
// ever reveal because the messages arrive on a phone.
func TestTheReportIsGatedOnAPaidLicence(t *testing.T) {
	for _, c := range []struct {
		name    string
		key     string
		wantOut bool
	}{
		{"no key at all", "", false},
		{"a licence that lapsed", expiredKey(), false},
		{"not a Caprock key", "sk-not-ours-1234567890", false},
		{"a paid licence", activeKey(), true},
	} {
		t.Run(c.name, func(t *testing.T) {
			tg := &telegramStub{}
			d, st := reportDaemon(t, tg.start(t), config.Config{
				ReportBotToken: "tok", ReportChatID: "chat", LicenseKey: c.key,
			})
			d.weeklyOnce(context.Background())

			if got := tg.count() > 0; got != c.wantOut {
				t.Errorf("sent = %v, want %v", got, c.wantOut)
			}
			// An unlicensed daemon must also leave the marker alone. Burning the
			// week here would mean that paying on Tuesday costs the customer the
			// report for the week they just paid for.
			marker, _ := st.GetMeta(context.Background(), store.MetaReportWeek)
			if !c.wantOut && marker != "" {
				t.Errorf("an ungated week was consumed anyway: %q", marker)
			}
		})
	}
}

// The marker is written BEFORE the send precisely so a failing network cannot
// turn an hourly check into five copies of the same message on someone's phone.
// This pins that ordering: after a refused send the week is still consumed.
func TestAFailedSendStillConsumesTheWeek(t *testing.T) {
	ctx := context.Background()
	tg := &telegramStub{fail: "chat not found"}
	d, st := reportDaemon(t, tg.start(t), config.Config{
		ReportBotToken: "tok", ReportChatID: "chat", LicenseKey: activeKey(),
	})

	d.weeklyOnce(ctx)
	if tg.count() != 1 {
		t.Fatalf("tried to send %d times, want 1", tg.count())
	}
	if marker, _ := st.GetMeta(ctx, store.MetaReportWeek); marker != isoWeek(time.Now()) {
		t.Fatalf("the week was not consumed after a failed send: %q", marker)
	}
	// The reason is on the settings screen and in the store, because an absent
	// message is a failure nobody notices.
	if !strings.Contains(d.reportLastError(), "chat not found") {
		t.Errorf("the failure was not explained: %q", d.reportLastError())
	}
	if got, _ := st.GetMeta(ctx, store.MetaReportLastError); !strings.Contains(got, "chat not found") {
		t.Errorf("the failure did not reach the store: %q", got)
	}
	// A success is not claimed for a message that never arrived.
	if d.reportLastSent() != 0 {
		t.Errorf("a failed send recorded a send time: %d", d.reportLastSent())
	}

	// The hourly check runs again — and must stay quiet.
	d.weeklyOnce(ctx)
	if tg.count() != 1 {
		t.Fatalf("the next hourly check sent a second copy: %d sends", tg.count())
	}
}

// The check runs every hour, all week. Exactly one message may result — the
// difference between a weekly report and a phone buzzing all afternoon.
func TestOneReportPerWeekAcrossManyChecks(t *testing.T) {
	ctx := context.Background()
	tg := &telegramStub{}
	d, st := reportDaemon(t, tg.start(t), config.Config{
		ReportBotToken: "tok", ReportChatID: "chat", LicenseKey: activeKey(),
	})

	for i := 0; i < 12; i++ {
		d.weeklyOnce(ctx)
	}
	if tg.count() != 1 {
		t.Fatalf("%d messages for one week", tg.count())
	}
	if d.reportLastSent() == 0 {
		t.Error("a delivered report recorded no send time; the panel would say it never sent")
	}
	if got := d.reportLastError(); got != "" {
		t.Errorf("a successful send left an error on screen: %q", got)
	}

	// A new week releases it again, or the report would send once and never
	// again for the life of the install.
	if err := st.SetMeta(ctx, store.MetaReportWeek, isoWeek(time.Now().AddDate(0, 0, -7))); err != nil {
		t.Fatal(err)
	}
	d.weeklyOnce(ctx)
	if tg.count() != 2 {
		t.Fatalf("the next week did not send: %d messages total", tg.count())
	}
}

// A restart must not re-send: the marker is in the store rather than in memory
// for exactly this reason, and restarting is what somebody does when they think
// a feature is broken.
func TestARestartDoesNotResendTheWeek(t *testing.T) {
	ctx := context.Background()
	tg := &telegramStub{}
	cfg := config.Config{ReportBotToken: "tok", ReportChatID: "chat", LicenseKey: activeKey()}
	d, st := reportDaemon(t, tg.start(t), cfg)

	d.weeklyOnce(ctx)
	if tg.count() != 1 {
		t.Fatalf("first send: %d messages", tg.count())
	}

	// A fresh Daemon over the same store is the restart: no in-memory state
	// carries over, only what was written down.
	rec := rollup.New(st, embeddedTable(t), bus.New(), quietLog())
	rec.Location = time.UTC
	fresh := &Daemon{log: quietLog(), store: st, rec: rec, opt: Options{Config: cfg}}
	fresh.report.base = d.report.base
	fresh.loadReportState(ctx)
	fresh.weeklyOnce(ctx)

	if tg.count() != 1 {
		t.Fatalf("a restart sent the week's report again: %d messages", tg.count())
	}
}

// Somebody pastes a token and a chat id and presses send. The failure mode of
// this feature is silence, so the button has to be able to answer "that chat id
// is wrong" in the moment rather than a week later.
func TestSendNowReportsWhyItCouldNotSend(t *testing.T) {
	ctx := context.Background()

	for _, c := range []struct {
		name string
		cfg  config.Config
		want string
	}{
		{"no bot at all", config.Config{LicenseKey: activeKey()}, "no bot configured"},
		{"a chat id but no token", config.Config{ReportChatID: "chat", LicenseKey: activeKey()}, "no bot configured"},
		{"a bot but no licence", config.Config{ReportBotToken: "tok", ReportChatID: "chat"}, "premium"},
	} {
		t.Run(c.name, func(t *testing.T) {
			tg := &telegramStub{}
			d, _ := reportDaemon(t, tg.start(t), c.cfg)
			err := d.SendReportNow(ctx)
			if err == nil {
				t.Fatal("a send that cannot work reported success")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Errorf("error = %q, want it to mention %q", err, c.want)
			}
			if tg.count() != 0 {
				t.Error("a refused send reached the network anyway")
			}
		})
	}
}

// The test button must not cost the customer their real Monday report: it
// deliberately leaves the week marker alone.
func TestSendNowDoesNotConsumeTheWeek(t *testing.T) {
	ctx := context.Background()
	tg := &telegramStub{}
	d, st := reportDaemon(t, tg.start(t), config.Config{
		ReportBotToken: "tok", ReportChatID: "chat", LicenseKey: activeKey(),
	})

	if err := d.SendReportNow(ctx); err != nil {
		t.Fatalf("send now: %v", err)
	}
	if tg.count() != 1 {
		t.Fatalf("the button sent %d messages", tg.count())
	}
	if marker, _ := st.GetMeta(ctx, store.MetaReportWeek); marker != "" {
		t.Fatalf("a test send burned the real week: %q", marker)
	}
	// So the scheduled report still goes out.
	d.weeklyOnce(ctx)
	if tg.count() != 2 {
		t.Fatalf("the scheduled report was skipped after a test send: %d messages", tg.count())
	}
}

// A failed test send is recorded the same way a scheduled one is — the reason
// is as useful now as it would be on a Monday — and a later success clears it,
// so nobody hunts a problem they have already fixed.
func TestSendNowRecordsAndThenClearsTheReason(t *testing.T) {
	ctx := context.Background()
	tg := &telegramStub{fail: "bot was blocked by the user"}
	d, st := reportDaemon(t, tg.start(t), config.Config{
		ReportBotToken: "tok", ReportChatID: "chat", LicenseKey: activeKey(),
	})

	if err := d.SendReportNow(ctx); err == nil {
		t.Fatal("a refused message reported success")
	}
	if !strings.Contains(d.reportLastError(), "blocked") {
		t.Fatalf("the reason was not kept: %q", d.reportLastError())
	}
	if got, _ := st.GetMeta(ctx, store.MetaReportLastError); !strings.Contains(got, "blocked") {
		t.Fatalf("the reason did not survive to the store: %q", got)
	}

	// They unblock the bot and press the button again.
	tg.mu.Lock()
	tg.fail = ""
	tg.mu.Unlock()
	if err := d.SendReportNow(ctx); err != nil {
		t.Fatalf("send now after the fix: %v", err)
	}
	if got := d.reportLastError(); got != "" {
		t.Errorf("a stale error survived a working send: %q", got)
	}
	if got, _ := st.GetMeta(ctx, store.MetaReportLastError); got != "" {
		t.Errorf("the stale error is still in the store: %q", got)
	}
}

// The figures are list prices, not a bill, and rule 6 puts that caveat in the
// message itself rather than only on a screen the reader is not looking at.
//
// Asserted on a week that actually has a figure in it: the no-data message
// states no cost, so there is nothing there to be mistaken for a bill.
func TestTheMessageCarriesItsCostingBasis(t *testing.T) {
	ctx := context.Background()
	tg := &telegramStub{}
	d, _ := reportDaemon(t, tg.start(t), config.Config{
		ReportBotToken: "tok", ReportChatID: "chat", LicenseKey: activeKey(),
	})
	spend(ctx, t, d, "myrepo", 12.50)

	if err := d.SendReportNow(ctx); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(d.reportBasis(), "not a bill") {
		t.Errorf("the basis does not disclaim the bill: %q", d.reportBasis())
	}
	if !strings.Contains(tg.last(), d.reportBasis()) {
		t.Errorf("the delivered message does not carry the basis:\n%s", tg.last())
	}
	// And the money it disclaims is really in there, or the caveat is attached
	// to nothing.
	if !strings.Contains(tg.last(), "12") {
		t.Errorf("the week's spend is missing from the message:\n%s", tg.last())
	}
}

// spend records one priced assistant turn against a project, dated yesterday.
//
// Yesterday rather than now on purpose: the report window ends at the start of
// today, so a turn recorded at this instant falls outside the week it is meant
// to be part of and the message comes out empty.
func spend(ctx context.Context, t *testing.T, d *Daemon, project string, usd float64) {
	t.Helper()
	cost := usd
	ev := &event.Event{
		Ts: time.Now().AddDate(0, 0, -1), SessionID: "s-" + project, Source: event.SourceHook,
		Kind: event.KindTurnAssistant, Model: "claude-opus-5",
		Tokens: &event.TokenDelta{In: 1000, Out: 500}, CostUSD: &cost,
		Payload: json.RawMessage(`{}`),
	}
	if _, err := d.rec.Record(ctx, ev, rollup.SessionInfo{Cwd: "/home/u/" + project}); err != nil {
		t.Fatal(err)
	}
}

// buildWeekly reads the daily rollups. An empty machine must produce a report
// rather than an error, or the first week after an install fails to send and
// the settings panel blames the bot.
func TestBuildWeeklyOnAnEmptyMachine(t *testing.T) {
	d, _ := reportDaemon(t, "", config.Config{})
	rep, err := d.buildWeekly(context.Background(), time.Now())
	if err != nil {
		t.Fatalf("an empty machine could not build a report: %v", err)
	}
	if rep.CostUSD != 0 {
		t.Errorf("an empty machine reported $%.2f", rep.CostUSD)
	}
}

// The week the report covers is the one that just ended, in the user's own
// timezone — a report labelled with the wrong week is worse than none.
func TestBuildWeeklyCoversTheSevenDaysThatJustEnded(t *testing.T) {
	d, _ := reportDaemon(t, "", config.Config{})
	now := time.Date(2026, 9, 9, 16, 30, 0, 0, time.UTC)

	rep, err := d.buildWeekly(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	// The window ends at the start of today and runs back exactly seven days,
	// so a partial today cannot make the week look cheap.
	wantEnd := time.Date(2026, 9, 9, 0, 0, 0, 0, time.UTC)
	if !rep.WeekEnd.Equal(wantEnd) {
		t.Errorf("week ends %s, want %s", rep.WeekEnd, wantEnd)
	}
	if got := rep.WeekEnd.Sub(rep.WeekStart); got != 7*24*time.Hour {
		t.Errorf("the report covers %s, want 7 days", got)
	}
}

// The week ends at the start of today, so a partial today cannot drag the
// figure down and make a normal week look like a quiet one. Spend from today is
// held back for next week's report rather than counted early.
func TestTodaysSpendIsNotCountedInThisWeeksReport(t *testing.T) {
	ctx := context.Background()
	d, _ := reportDaemon(t, "", config.Config{})

	// Recorded now — inside the current day, outside the reported week.
	cost := 99.0
	ev := &event.Event{
		Ts: time.Now(), SessionID: "s-today", Source: event.SourceHook,
		Kind: event.KindTurnAssistant, Model: "claude-opus-5",
		Tokens: &event.TokenDelta{In: 10, Out: 10}, CostUSD: &cost,
		Payload: json.RawMessage(`{}`),
	}
	if _, err := d.rec.Record(ctx, ev, rollup.SessionInfo{Cwd: "/home/u/today"}); err != nil {
		t.Fatal(err)
	}

	rep, err := d.buildWeekly(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if rep.CostUSD != 0 {
		t.Errorf("today's $%.2f was counted in the week that ended this morning", rep.CostUSD)
	}
}
