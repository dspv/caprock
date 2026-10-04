package daemon

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

// A permission dialog reaches the phone with no licence: alerts are free even
// though the weekly report that shares the bot is not (ADR-036). The message
// names the project, the status and the agent — and nothing the session said.
func TestADialogReachesThePhoneWithoutALicence(t *testing.T) {
	tg := &telegramStub{}
	d, _ := reportDaemon(t, tg.start(t), config.Config{ReportBotToken: "tok", ReportChatID: "chat"})
	d.bus = d.rec.Bus
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.alertLoop(ctx, d.bus.Subscribe(64))

	info := rollup.SessionInfo{Cwd: "/home/u/caprock"}
	pre := &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash", Ts: reportNow,
		Key: "pre:t1", Payload: json.RawMessage(`{"tool_input":{"command":"rm -rf secret-dir"}}`)}
	ask := &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindPermissionPrompt, Ts: reportNow.Add(time.Second),
		Payload: json.RawMessage(`{"message":"Claude needs your permission to use Bash"}`)}
	for _, ev := range []*event.Event{pre, ask} {
		if _, err := d.rec.Record(ctx, ev, info); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for tg.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if got, want := tg.last(), "Caprock · caprock is waiting for approval\nClaude Code"; got != want {
		t.Fatalf("message = %q, want %q", got, want)
	}
	if errText, sent := d.phone.get(); errText != "" || sent == 0 {
		t.Errorf("outcome not recorded: err=%q sent=%d", errText, sent)
	}
}

// Without a bot the switches mean nothing and nothing leaves the machine.
func TestNoBotNoAlerts(t *testing.T) {
	d, _ := reportDaemon(t, "http://127.0.0.1:1", config.Config{})
	if d.alertEnabled("approval") || d.alertEnabled("finished") {
		t.Fatal("an alert kind is enabled with no bot configured")
	}
	if err := d.SendAlertCheck(context.Background()); err == nil {
		t.Fatal("a test alert was attempted with no bot")
	}
}

func TestASwitchTurnsOneKindOff(t *testing.T) {
	off := false
	d, _ := reportDaemon(t, "http://127.0.0.1:1", config.Config{ReportBotToken: "tok", ReportChatID: "chat", AlertFinished: &off})
	if !d.alertEnabled("approval") || d.alertEnabled("finished") {
		t.Fatal("switches not honoured")
	}
}

// The test alert reports Telegram's own refusal, and the panel keeps it.
func TestTheTestAlertSaysWhyItFailed(t *testing.T) {
	tg := &telegramStub{fail: "chat not found"}
	d, _ := reportDaemon(t, tg.start(t), config.Config{ReportBotToken: "tok", ReportChatID: "chat"})
	if err := d.SendAlertCheck(context.Background()); err == nil {
		t.Fatal("a refused test alert reported success")
	}
	if errText, _ := d.phone.get(); errText != "telegram: chat not found" {
		t.Errorf("last error = %q", errText)
	}
}

// The link opens the session on the phone, at the address phone access
// listens on; with phone access off there is no link rather than a loopback
// one that opens nothing.
func TestTheLinkIsThePhoneAddressOrNothing(t *testing.T) {
	d := &Daemon{}
	if got := d.sessionLink("s1"); got != "" {
		t.Fatalf("link with phone access off = %q", got)
	}
	d.lanURL = "http://100.64.0.2:4173"
	if got := d.sessionLink("s1"); got != "http://100.64.0.2:4173/#/session/s1" {
		t.Fatalf("link = %q", got)
	}
}
