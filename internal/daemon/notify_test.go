package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/alerts"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

// notifySink collects the notify frames the daemon publishes.
type notifySink struct {
	mu  sync.Mutex
	got []alerts.Notification
}

func (s *notifySink) watch(ctx context.Context, b *bus.Bus) {
	sub := b.Subscribe(256)
	go func() {
		defer sub.Unsubscribe()
		for {
			select {
			case <-ctx.Done():
				return
			case f := <-sub.C:
				if n, ok := f.Data.(alerts.Notification); ok && f.Type == bus.FrameNotify {
					s.mu.Lock()
					s.got = append(s.got, n)
					s.mu.Unlock()
				}
			}
		}
	}()
}

func (s *notifySink) all() []alerts.Notification {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]alerts.Notification(nil), s.got...)
}

// alertHarness runs the alert loop over a test daemon with Telegram faked.
func alertHarness(t *testing.T, cfg config.Config) (*Daemon, *telegramStub, *notifySink, context.Context) {
	t.Helper()
	tg := &telegramStub{}
	d, _ := reportDaemon(t, tg.start(t), cfg)
	d.bus = d.rec.Bus
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	sink := &notifySink{}
	sink.watch(ctx, d.bus)
	go d.alertLoop(ctx, d.bus.Subscribe(1024))
	return d, tg, sink, ctx
}

func recordPrompt(t *testing.T, ctx context.Context, d *Daemon, session string, at time.Time) {
	t.Helper()
	ev := &event.Event{SessionID: session, Source: event.SourceHook, Kind: event.KindPermissionPrompt, Tool: "Bash", Ts: at,
		Payload: json.RawMessage(`{"tool_name":"Bash","tool_input":{"command":"go test ./..."}}`)}
	if _, err := d.rec.Record(ctx, ev, rollup.SessionInfo{Cwd: "/home/u/caprock", GitBranch: "main"}); err != nil {
		t.Fatal(err)
	}
}

// settle waits until both senders have delivered want, then a moment more so
// an extra delivery would be seen.
func settle(t *testing.T, tg *telegramStub, sink *notifySink, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for (tg.count() < want || len(sink.all()) < want) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond)
}

// Telegram and the notify frame are two senders of one decision: the hourly
// cap of 20 holds for both, and both say so on the twentieth.
func TestBothSendersShareTheHourlyCap(t *testing.T) {
	on := true
	d, tg, sink, ctx := alertHarness(t, config.Config{ReportBotToken: "tok", ReportChatID: "chat", AlertApproval: &on, NotifyApproval: &on})
	for i := range alerts.HourlyCap + 5 {
		recordPrompt(t, ctx, d, fmt.Sprintf("s%02d", i), reportNow)
	}
	settle(t, tg, sink, alerts.HourlyCap)
	notes := sink.all()
	if tg.count() != alerts.HourlyCap || len(notes) != alerts.HourlyCap {
		t.Fatalf("telegram sent %d, notify published %d; want %d each", tg.count(), len(notes), alerts.HourlyCap)
	}
	capped := 0
	for _, n := range notes {
		if strings.Contains(n.Body, "the rest wait") {
			capped++
		}
	}
	tg.mu.Lock()
	tgCapped := 0
	for _, m := range tg.sent {
		if strings.Contains(m, "the rest wait") {
			tgCapped++
		}
	}
	tg.mu.Unlock()
	if capped != 1 || tgCapped != 1 {
		t.Fatalf("the cap was announced %d times in notify and %d in Telegram, want once each", capped, tgCapped)
	}
}

// The per-session cooldown holds for both: a second dialog in one session a
// minute after the first is answered pages neither.
func TestBothSendersShareTheCooldown(t *testing.T) {
	on := true
	d, tg, sink, ctx := alertHarness(t, config.Config{ReportBotToken: "tok", ReportChatID: "chat", AlertApproval: &on})
	recordPrompt(t, ctx, d, "s1", reportNow.Add(-90*time.Second))
	answered := &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPost, Tool: "Bash", Ts: reportNow.Add(-80 * time.Second),
		Key: "post:t1", Payload: json.RawMessage(`{}`)}
	if _, err := d.rec.Record(ctx, answered, rollup.SessionInfo{}); err != nil {
		t.Fatal(err)
	}
	recordPrompt(t, ctx, d, "s1", reportNow.Add(-30*time.Second))
	settle(t, tg, sink, 1)
	if tg.count() != 1 || len(sink.all()) != 1 {
		t.Fatalf("telegram sent %d, notify published %d; want 1 each", tg.count(), len(sink.all()))
	}
}

// Defaults (owner, 2026-10-06): Telegram stays off until switched on, while
// the app's approval notification is on — with no bot at all, a dialog still
// reaches the app and nothing leaves the machine.
func TestTheAppHearsOfADialogWithTelegramOff(t *testing.T) {
	d, tg, sink, ctx := alertHarness(t, config.Config{})
	recordPrompt(t, ctx, d, "s1", reportNow)
	deadline := time.Now().Add(time.Second)
	for len(sink.all()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	got := sink.all()
	if len(got) != 1 {
		t.Fatalf("no notify frame within a second of the dialog: %+v", got)
	}
	if n := got[0]; n.Kind != "approval" || n.Title != "Needs approval · caprock" || !strings.Contains(n.Body, "Bash: go test ./...") {
		t.Fatalf("notification %+v", n)
	}
	time.Sleep(100 * time.Millisecond)
	if tg.count() != 0 {
		t.Fatalf("Telegram sent %d with no bot and its switches off", tg.count())
	}
}

// Each sender has its own switch: the app's off leaves Telegram's alone.
func TestTheAppSwitchIsApartFromTelegrams(t *testing.T) {
	on, off := true, false
	d, tg, sink, ctx := alertHarness(t, config.Config{ReportBotToken: "tok", ReportChatID: "chat", AlertApproval: &on, NotifyApproval: &off})
	recordPrompt(t, ctx, d, "s1", reportNow)
	settle(t, tg, sink, 1)
	if tg.count() != 1 || len(sink.all()) != 0 {
		t.Fatalf("telegram sent %d, notify published %d; want 1 and 0", tg.count(), len(sink.all()))
	}
}

// "Finished" is off in the app unless switched on.
func TestAFinishedNotificationIsOffByDefault(t *testing.T) {
	stop := event.Event{SessionID: "s1", Kind: event.KindAgentStop, Ts: reportNow}
	a := alerts.Alert{Kind: alerts.KindFinished, SessionID: "s1", Trigger: stop}
	for _, c := range []struct {
		name string
		cfg  config.Config
		want int
	}{
		{"default", config.Config{}, 0},
		{"switched on", config.Config{NotifyFinished: ptr(true)}, 1},
	} {
		t.Run(c.name, func(t *testing.T) {
			d, _ := reportDaemon(t, "http://127.0.0.1:1", c.cfg)
			d.bus = d.rec.Bus
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			sink := &notifySink{}
			sink.watch(ctx, d.bus)
			d.deliverAlert(ctx, a)
			time.Sleep(50 * time.Millisecond)
			if got := len(sink.all()); got != c.want {
				t.Fatalf("published %d, want %d", got, c.want)
			}
		})
	}
}

func ptr[T any](v T) *T { return &v }
