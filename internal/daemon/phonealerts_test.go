package daemon

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/alerts"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

// A notification answers a prompt only when it is the only one outstanding:
// with two, which the terminal shows is unknown, and an Approve would press a
// key into whichever is in front (ADR-035, amended 2026-10-09).
func TestANotificationAnswersOnlyALonePrompt(t *testing.T) {
	if got := answerablePrompt(&agents.Permission{ID: "p1"}, true); got != "p1" {
		t.Fatalf("one outstanding: %q", got)
	}
	if got := answerablePrompt(&agents.Permission{ID: "p1", Queued: 1}, true); got != "" {
		t.Fatalf("two outstanding: %q", got)
	}
	if got := answerablePrompt(nil, false); got != "" {
		t.Fatalf("none: %q", got)
	}
}

// A permission dialog reaches the phone with no licence: alerts are free even
// though the weekly report that shares the bot is not (ADR-036). The message
// says what happened, where, and the command the dialog asks about, in HTML.
func TestADialogReachesThePhoneWithoutALicence(t *testing.T) {
	tg := &telegramStub{}
	on := true
	d, _ := reportDaemon(t, tg.start(t), config.Config{ReportBotToken: "tok", ReportChatID: "chat", AlertApproval: &on})
	d.bus = d.rec.Bus
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.alertLoop(ctx, d.bus.Subscribe(64))

	info := rollup.SessionInfo{Cwd: "/home/u/caprock", GitBranch: "main", Title: "Tidy the <cache>"}
	pre := &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash", Ts: reportNow,
		Key: "pre:t1", Payload: json.RawMessage(`{"tool_input":{"command":"rm -rf secret-dir"}}`)}
	ask := &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindPermissionPrompt, Tool: "Bash", Ts: reportNow.Add(time.Second),
		Payload: json.RawMessage(`{"tool_name":"Bash","tool_input":{"command":"rm -rf secret-dir"}}`)}
	for _, ev := range []*event.Event{pre, ask} {
		if _, err := d.rec.Record(ctx, ev, info); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for tg.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	want := "⏳ <b>Needs approval</b> · Tidy the &lt;cache&gt;\n<code>/home/u/caprock</code> · main\nBash: <code>rm -rf secret-dir</code>"
	if got := tg.last(); got != want {
		t.Fatalf("message = %q, want %q", got, want)
	}
	if tg.modes[0] != "HTML" {
		t.Fatalf("parse_mode = %q", tg.modes[0])
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
	on, off := true, false
	d, _ := reportDaemon(t, "http://127.0.0.1:1", config.Config{ReportBotToken: "tok", ReportChatID: "chat", AlertApproval: &on, AlertFinished: &off})
	if !d.alertEnabled("approval") || d.alertEnabled("finished") {
		t.Fatal("switches not honoured")
	}
}

// A bot set up for the weekly report does not start sending alerts on its
// own: both kinds stay off until switched on (owner, 2026-10-05).
func TestAlertsAreOffUntilSwitchedOn(t *testing.T) {
	d, _ := reportDaemon(t, "http://127.0.0.1:1", config.Config{ReportBotToken: "tok", ReportChatID: "chat"})
	if d.alertEnabled("approval") || d.alertEnabled("finished") {
		t.Fatal("an alert kind is on although nobody switched it on")
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

// A finished alert reports the run since the last prompt — not the session —
// with its time, cost, tool calls, changed files and the reply's first line,
// and leaves the reply out when the owner switched it off.
func TestAFinishedAlertReportsTheRun(t *testing.T) {
	tg := &telegramStub{}
	d, _ := reportDaemon(t, tg.start(t), config.Config{ReportBotToken: "tok", ReportChatID: "chat"})
	ctx := context.Background()
	info := rollup.SessionInfo{Cwd: "/home/u/caprock", GitBranch: "feat/x", Title: "Fix alerts"}
	cost := func(v float64) *float64 { return &v }
	at := func(s int) time.Time { return reportNow.Add(time.Duration(s) * time.Second) }
	edit := func(key, tool, file string, s int) *event.Event {
		return &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPre, Tool: tool, Ts: at(s), Key: key,
			Payload: json.RawMessage(`{"tool_input":{"file_path":"` + file + `"}}`)}
	}
	stop := &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindAgentStop, Ts: at(750),
		Payload: json.RawMessage(`{"last_assistant_message":"All green.\nDetails follow."}`)}
	for _, ev := range []*event.Event{
		// An earlier run, which the alert must not count.
		{SessionID: "s1", Source: event.SourceHook, Kind: event.KindTurnUser, Ts: at(-600), Key: "prompt:p0", Payload: json.RawMessage(`{"prompt":"first"}`)},
		{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: at(-590), Key: "msg:m0", CostUSD: cost(5), Payload: json.RawMessage(`{}`)},
		edit("pre:t0", "Edit", "/home/u/caprock/old.go", -580),
		// This run.
		{SessionID: "s1", Source: event.SourceHook, Kind: event.KindTurnUser, Ts: at(0), Key: "prompt:p1", Payload: json.RawMessage(`{"prompt":"fix them"}`)},
		{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: at(10), Key: "msg:m1", CostUSD: cost(0.5), Payload: json.RawMessage(`{}`)},
		edit("pre:t1", "Edit", "/home/u/caprock/a.go", 20),
		edit("pre:t2", "Edit", "/home/u/caprock/a.go", 30),
		edit("pre:t3", "Write", "/home/u/caprock/b.go", 40),
		edit("pre:t4", "Read", "/home/u/caprock/c.go", 50),
		{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: at(740), Key: "msg:m2", CostUSD: cost(0.25), Payload: json.RawMessage(`{}`)},
		stop,
	} {
		if _, err := d.rec.Record(ctx, ev, info); err != nil {
			t.Fatal(err)
		}
	}
	a := alerts.Alert{Kind: alerts.KindFinished, SessionID: "s1", Trigger: *stop}
	d.sendAlert(ctx, a)
	want := "✅ <b>Finished</b> · Fix alerts\n<code>/home/u/caprock</code> · feat/x\n12m · $0.75 · 4 tool calls\n2 files changed: a.go, b.go\n💬 <i>All green.</i>"
	if got := tg.last(); got != want {
		t.Fatalf("message =\n%s\nwant\n%s", got, want)
	}

	off := false
	d.opt.Config.AlertReply = &off
	d.sendAlert(ctx, a)
	if got := tg.last(); strings.Contains(got, "All green") {
		t.Fatalf("reply sent with the switch off:\n%s", got)
	}
}
