package daemon

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/alerts"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/license"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/telegram/telegramtest"
)

// farKey is a licence that outlives the wall clock the bridge reads.
func farKey() string { return license.Prefix + "2099-01-01-test" }

// bridgeDaemon is a report daemon with the Telegram bridge running against a
// fake bot, and the alert loop listening.
func bridgeDaemon(t *testing.T, cfg config.Config) (*Daemon, *telegramtest.Bot) {
	t.Helper()
	bot := telegramtest.New("tok", "caprock_bot")
	t.Cleanup(bot.Close)
	cfg.ReportBotToken, cfg.ReportChatID = "tok", "777"
	d, _ := reportDaemon(t, bot.URL(), cfg)
	d.opt.DataDir = t.TempDir()
	d.bus = d.rec.Bus
	d.tg = d.newTelegram()
	d.tg.Out.Gap = 10 * time.Millisecond
	d.tg.PollWait = time.Second
	sub := d.bus.Subscribe(64) // before the first event a test records
	runJoined(t, func(ctx context.Context) { d.tg.Run(ctx) }, func(ctx context.Context) { d.alertLoop(ctx, sub) })
	return d, bot
}

// runJoined runs each loop until the test ends, then cancels them and waits
// for every one to return — before the test's temporary directories are
// removed (cleanups run last-registered first), so nothing still writes
// telegram.json or config.json there. Windows cannot delete a directory a
// file is being written in.
func runJoined(t *testing.T, loops ...func(context.Context)) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	for _, loop := range loops {
		wg.Add(1)
		go func() {
			defer wg.Done()
			loop(ctx)
		}()
	}
	t.Cleanup(func() {
		cancel()
		wg.Wait()
	})
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A free alert goes through the bridge with a Mute button and no Approve:
// answering from Telegram is Premium. Muting it silences the session.
func TestAFreeAlertCanBeMutedButNotAnswered(t *testing.T) {
	on := true
	d, bot := bridgeDaemon(t, config.Config{AlertApproval: &on, AlertFinished: &on})
	ctx := context.Background()
	ask := &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindPermissionPrompt, Tool: "Bash", Ts: reportNow,
		Payload: json.RawMessage(`{"tool_name":"Bash","tool_input":{"command":"go test ./..."}}`)}
	if _, err := d.rec.Record(ctx, ask, rollup.SessionInfo{Cwd: "/home/u/caprock", Title: "Fix the cache test"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the alert", func() bool { return len(bot.Messages()) == 1 })
	m := bot.Messages()[0]
	if !strings.HasPrefix(m.Text, "🟠 Claude Code · caprock · Fix the cache test\n⏳ <b>Needs approval</b>") {
		t.Fatalf("text = %q", m.Text)
	}
	if len(m.Buttons) != 1 || m.Buttons[0] != "m" {
		t.Fatalf("buttons = %v", m.Buttons)
	}
	bot.Press(777, m.MessageID, "m")
	waitFor(t, "the mute", func() bool { return d.tg.Muted("s1") })
	d.deliverAlert(ctx, alerts.Alert{Kind: alerts.KindFinished, SessionID: "s1", Trigger: *ask})
	time.Sleep(100 * time.Millisecond)
	if n := len(bot.Messages()); n != 1 {
		t.Fatalf("a muted session sent %d more", n-1)
	}
}

// A session the owner talks to from Telegram answers there the moment its
// turn ends — not a minute later — with the whole reply, code left out; and
// the rules' own finished alert for it does not follow.
func TestAConversationGetsItsReplyAtOnce(t *testing.T) {
	on := true
	d, bot := bridgeDaemon(t, config.Config{LicenseKey: farKey(), TelegramChat: &on, AlertFinished: &on})
	ctx := context.Background()
	d.tg.Converse("s1")
	reply := "Fixed the cache test.\n\n```go\nfunc TestCache(t *testing.T) {}\n```\nAll green now."
	stop := &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindAgentStop, Ts: reportNow,
		Payload: json.RawMessage(`{"last_assistant_message":` + jsonString(reply) + `}`)}
	start := time.Now()
	if _, err := d.rec.Record(ctx, stop, rollup.SessionInfo{Cwd: "/home/u/caprock", Title: "Fix the cache test"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the reply", func() bool { return len(bot.Messages()) == 1 })
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("the reply took %v", took)
	}
	m := bot.Messages()[0]
	for _, want := range []string{"🟠 Claude Code · caprock · Fix the cache test", "Fixed the cache test.", "<i>[go, 1 line]</i>", "All green now."} {
		if !strings.Contains(m.Text, want) {
			t.Fatalf("reply lacks %q:\n%s", want, m.Text)
		}
	}
	if strings.Contains(m.Text, "func TestCache") {
		t.Fatalf("code reached Telegram with the switch off:\n%s", m.Text)
	}
	d.deliverAlert(ctx, alerts.Alert{Kind: alerts.KindFinished, SessionID: "s1", Trigger: *stop})
	time.Sleep(100 * time.Millisecond)
	if n := len(bot.Messages()); n != 1 {
		t.Fatalf("the finished alert followed the reply: %d messages", n)
	}
}

// Rule 7 below the bridge: the daemon refuses to type into a session it did
// not start, whatever the bridge asks.
func TestTelegramNeverTypesIntoASessionCaprockDidNotStart(t *testing.T) {
	d, _ := reportDaemon(t, "http://127.0.0.1:1", config.Config{})
	d.mgr = agents.NewManager(d.store, t.TempDir(), "", quietLog())
	err := (&tgHost{d: d}).Type("someone-elses", "rm -rf ~")
	if err == nil || !strings.Contains(err.Error(), "did not start") {
		t.Fatalf("err = %v", err)
	}
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
