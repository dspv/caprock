package daemon

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
)

// A module's notification is a notify frame naming the module, whose click
// opens it; with desktop notifications off there is none.
func TestAModuleNotificationFollowsTheDesktopSwitches(t *testing.T) {
	off := false
	d := &Daemon{log: quietLog(), bus: bus.New(), opt: Options{Config: config.Config{NotifyApproval: &off, NotifyFinished: &off}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink := &notifySink{}
	sink.watch(ctx, d.bus)

	if (moduleNotifier{d: d}).NotifyModule("ops", "Ops desk", "Review ready", "3 items") {
		t.Fatal("published with desktop notifications off")
	}
	on := true
	d.opt.Config.NotifyFinished = &on
	if !(moduleNotifier{d: d}).NotifyModule("ops", "Ops desk", "Review ready", "3 items") {
		t.Fatal("not published with a switch on")
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(sink.all()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	got := sink.all()
	if len(got) != 1 {
		t.Fatalf("frames %+v", got)
	}
	n := got[0]
	if n.Kind != "module" || n.Title != "Ops desk · Review ready" || n.Body != "3 items" || n.Route != "#/x/ops" || n.SessionID != "" {
		t.Fatalf("frame %+v", n)
	}
}

// An answer for a module the admin key does not name is not kept.
func TestAModuleAnswerNeedsTheKey(t *testing.T) {
	d := &Daemon{log: quietLog(), opt: Options{Config: config.Config{}}}
	if err := d.moduleAnswer(context.Background(), "ops", "1-1", map[string]any{"button": "yes"}); err != errModuleNotNamed {
		t.Fatalf("err = %v", err)
	}
}
