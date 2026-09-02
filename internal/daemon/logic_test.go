// The daemon's own decisions, tested without starting a daemon.
//
// Most of what is uncovered here is thin adapter plumbing — one-line methods
// that forward to board or agents, and are already exercised through those
// packages and the smoke suite. What is worth pinning is the logic the daemon
// alone owns: when a loop alert stops being current, what the settings endpoint
// is allowed to change, and that the background workers stop when asked.
package daemon

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/loop"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/update"
)

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func embeddedTable(t *testing.T) *cost.Table {
	t.Helper()
	tb, err := cost.Embedded()
	if err != nil {
		t.Fatal(err)
	}
	return tb
}

func memStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// A loop alert describes a session that is repeating itself right now. Once the
// detector's window has passed without a new occurrence, the loop is over —
// and the alert must stop being reported, or the dashboard shows a permanent
// red banner for a session that recovered minutes ago.
func TestActiveLoopExpiresOutsideTheWindow(t *testing.T) {
	d := &Daemon{
		log:    quietLog(),
		det:    &loop.Detector{Window: 5 * time.Minute},
		alerts: map[string]*loop.Alert{},
	}

	fresh := &loop.Alert{SessionID: "s-fresh", LastTs: time.Now().Add(-1 * time.Minute)}
	stale := &loop.Alert{SessionID: "s-stale", LastTs: time.Now().Add(-30 * time.Minute)}
	d.alerts["s-fresh"] = fresh
	d.alerts["s-stale"] = stale

	if got := d.activeLoop("s-fresh"); got != fresh {
		t.Errorf("a loop seen a minute ago = %v; want it reported as active", got)
	}
	if got := d.activeLoop("s-stale"); got != nil {
		t.Errorf("a loop last seen 30 minutes ago = %v; want nil", got)
	}
	// The expired entry must also be dropped, not merely hidden: keeping it
	// grows the map for the life of the process.
	if _, still := d.alerts["s-stale"]; still {
		t.Error("the expired alert is still in the map; it must be deleted")
	}
	if _, ok := d.alerts["s-fresh"]; !ok {
		t.Error("the current alert was deleted")
	}
}

func TestActiveLoopUnknownSession(t *testing.T) {
	d := &Daemon{log: quietLog(), det: &loop.Detector{Window: time.Minute}, alerts: map[string]*loop.Alert{}}
	if got := d.activeLoop("never-seen"); got != nil {
		t.Errorf("activeLoop for an unknown session = %v; want nil", got)
	}
}

// activeLoop is read by the API on every session render while the detector
// writes to the same map, so the lock has to hold under concurrency.
func TestActiveLoopIsRaceFree(t *testing.T) {
	d := &Daemon{log: quietLog(), det: &loop.Detector{Window: time.Minute}, alerts: map[string]*loop.Alert{}}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			d.mu.Lock()
			d.alerts["s"] = &loop.Alert{SessionID: "s", LastTs: time.Now()}
			d.mu.Unlock()
			_ = d.activeLoop("s")
		}()
	}
	wg.Wait()
}

// settingsAdapter round-trip. The plan is user-stated (Caprock cannot detect
// it), so what goes in must come back out unchanged — a silently dropped field
// would leave the dashboard pricing usage against the wrong plan.
func TestSettingsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	d := &Daemon{log: quietLog(), opt: Options{DataDir: dir}, baseCtx: context.Background()}
	a := &settingsAdapter{d: d}

	in := api.Settings{PlanKind: "flat", PlanLabel: "Max 20x", PlanUSDPerMonth: 200}
	if err := a.Set(in); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got := a.Get()
	if got.PlanKind != in.PlanKind || got.PlanLabel != in.PlanLabel || got.PlanUSDPerMonth != in.PlanUSDPerMonth {
		t.Errorf("Get = %+v; want %+v", got, in)
	}
	// And it must reach disk, or the plan resets on the next restart.
	saved, err := config.Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if saved.PlanLabel != "Max 20x" || saved.PlanUSDPerMonth != 200 {
		t.Errorf("on disk = %+v; the plan did not persist", saved)
	}
}

// Rule 4: the release check is the single outbound call, and it is off until
// the user turns it on. The daemon enforces that, not the UI — so the flag must
// travel exactly as given, in both directions.
func TestUpdateChecksFollowTheUserExactly(t *testing.T) {
	dir := t.TempDir()
	d := &Daemon{
		log:     quietLog(),
		opt:     Options{DataDir: dir},
		baseCtx: context.Background(),
		upd:     update.New(),
	}
	a := &settingsAdapter{d: d}

	if a.Get().UpdateChecks {
		t.Fatal("update checks default to on; rule 4 requires opt-in")
	}
	if err := a.Set(api.Settings{UpdateChecks: true}); err != nil {
		t.Fatalf("Set on: %v", err)
	}
	if !a.Get().UpdateChecks {
		t.Error("the opt-in did not stick")
	}
	// Revocable: turning it back off must persist too.
	if err := a.Set(api.Settings{UpdateChecks: false}); err != nil {
		t.Fatalf("Set off: %v", err)
	}
	if a.Get().UpdateChecks {
		t.Error("update checks stayed on after being switched off; the opt-in must be revocable")
	}
	saved, err := config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if saved.UpdateChecks {
		t.Error("disk still says checks are on")
	}
}

// Changing the plan must not silently switch the release check on or off — the
// settings PUT carries every field, and an omitted one would otherwise flip.
func TestSettingsDoNotDisturbEachOther(t *testing.T) {
	dir := t.TempDir()
	d := &Daemon{
		log:     quietLog(),
		opt:     Options{DataDir: dir},
		baseCtx: context.Background(),
		upd:     update.New(),
	}
	a := &settingsAdapter{d: d}

	if err := a.Set(api.Settings{UpdateChecks: true, PlanKind: "flat", PlanLabel: "Pro", PlanUSDPerMonth: 20}); err != nil {
		t.Fatal(err)
	}
	// Now change only the plan, carrying the checks flag through as the UI does.
	if err := a.Set(api.Settings{UpdateChecks: true, PlanKind: "metered", PlanLabel: "API"}); err != nil {
		t.Fatal(err)
	}
	got := a.Get()
	if !got.UpdateChecks {
		t.Error("changing the plan switched the release check off")
	}
	if got.PlanKind != "metered" {
		t.Errorf("PlanKind = %q; want the new value", got.PlanKind)
	}
}

// The background workers must exit when the daemon's context is cancelled;
// one that ignores it keeps a ticker (and the process) alive on shutdown.
func TestBackgroundWorkersStopOnCancel(t *testing.T) {
	st := memStore(t)
	d := &Daemon{
		log:   quietLog(),
		store: st,
		rec:   rollup.New(st, embeddedTable(t), bus.New(), quietLog()),
		opt:   Options{Config: config.Config{RetentionDays: 30}, IdleAfter: time.Minute, EndAfter: time.Hour},
	}

	for name, fn := range map[string]func(context.Context){
		"sweep":     d.sweep,
		"pruneLoop": d.pruneLoop,
	} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() { defer close(done); fn(ctx) }()
			cancel()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatalf("%s did not return on cancel; it would keep the process alive", name)
			}
		})
	}
}

// URL is what the CLI prints and what the browser is pointed at.
func TestURLReportsWhatWasBound(t *testing.T) {
	d := &Daemon{url: "http://127.0.0.1:4173"}
	if got := d.URL(); got != "http://127.0.0.1:4173" {
		t.Errorf("URL = %q", got)
	}
}

// loopFrame is one tool call on the bus, shaped so the detector will count it:
// a write tool with a stable signature, which is what a stuck agent produces.
func loopFrame(sessionID string, ts time.Time) bus.Frame {
	return bus.Frame{Type: bus.FrameEvent, Data: event.Event{
		Ts: ts, SessionID: sessionID, Source: event.SourceHook,
		Kind: event.KindToolPre, Tool: "Bash",
		Payload: json.RawMessage(`{"tool_input":{"command":"go test ./..."}}`),
	}}
}

// loopWatcher runs observeLoops over a bus and hands back the alerts it
// publishes, so a test can assert on what the dashboard would actually show.
func loopWatcher(t *testing.T) (*Daemon, *bus.Subscriber, func()) {
	t.Helper()
	b := bus.New()
	d := &Daemon{
		log: quietLog(), bus: b, alerts: map[string]*loop.Alert{},
		det: loop.New(3, 5*time.Minute),
		mgr: agents.NewManager(memStore(t), t.TempDir(), "", quietLog()),
		opt: Options{Config: config.Config{}},
	}
	// in is what observeLoops reads; out is where the alerts it raises land.
	in := b.Subscribe(64)
	out := b.Subscribe(64)

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		d.observeLoops(ctx, in)
	}()
	return d, out, func() {
		cancel()
		wg.Wait()
	}
}

// awaitAlert waits for a loop alert on the bus, or gives up. A deadline rather
// than a sleep: the goroutine publishes when it publishes.
func awaitAlert(t *testing.T, sub *bus.Subscriber) *loop.Alert {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case f := <-sub.C:
			if f.Type != bus.FrameAlert {
				continue
			}
			a, ok := f.Data.(*loop.Alert)
			if !ok {
				continue
			}
			return a
		case <-deadline:
			t.Fatal("no loop alert was published")
			return nil
		}
	}
}

// A session repeating the same command is the thing the loop detector exists to
// catch: it must reach the alert map (the red banner) and the bus (the live
// dashboard), or a runaway agent burns money with nothing on screen.
func TestALoopRaisesAnAlertOnTheBusAndInTheMap(t *testing.T) {
	d, out, stop := loopWatcher(t)
	defer stop()

	now := time.Now()
	for i := 0; i < 4; i++ {
		d.bus.Publish(loopFrame("s-stuck", now.Add(time.Duration(i)*time.Second)))
	}

	a := awaitAlert(t, out)
	if a.SessionID != "s-stuck" {
		t.Errorf("alert names session %q, want s-stuck", a.SessionID)
	}
	if a.Tool != "Bash" {
		t.Errorf("alert names tool %q, want Bash", a.Tool)
	}
	// And it is the alert /v1/status counts and the session view reads.
	if got := d.activeLoop("s-stuck"); got == nil {
		t.Error("the alert never reached the map the dashboard reads")
	}
}

// Startup replays history onto the same bus. Alerting on it would greet the
// user with a wall of red banners about loops that ended weeks ago — and, with
// auto-pause on, would pause live sessions because of what they did in July.
func TestBackfilledHistoryRaisesNoAlerts(t *testing.T) {
	d, out, stop := loopWatcher(t)
	defer stop()

	old := time.Now().Add(-24 * time.Hour)
	for i := 0; i < 6; i++ {
		d.bus.Publish(loopFrame("s-history", old.Add(time.Duration(i)*time.Second)))
	}

	// A fresh loop afterwards proves the watcher is alive and simply chose not
	// to alert on the old events — without it this test passes on a dead
	// goroutine.
	now := time.Now()
	for i := 0; i < 4; i++ {
		d.bus.Publish(loopFrame("s-live", now.Add(time.Duration(i)*time.Second)))
	}

	if a := awaitAlert(t, out); a.SessionID != "s-live" {
		t.Errorf("alerted on backfilled history: session %q", a.SessionID)
	}
	if d.activeLoop("s-history") != nil {
		t.Error("a loop from yesterday is on the dashboard as if it were happening now")
	}
}

// Everything else on the bus — session frames, alerts the watcher itself
// published — must pass through without being mistaken for a tool call.
func TestTheLoopWatcherIgnoresWhatIsNotAnEvent(t *testing.T) {
	d, out, stop := loopWatcher(t)
	defer stop()

	d.bus.Publish(bus.Frame{Type: bus.FrameSession, Data: "not an event"})
	d.bus.Publish(bus.Frame{Type: bus.FrameEvent, Data: "not an event either"})

	now := time.Now()
	for i := 0; i < 4; i++ {
		d.bus.Publish(loopFrame("s-ok", now.Add(time.Duration(i)*time.Second)))
	}
	if a := awaitAlert(t, out); a.SessionID != "s-ok" {
		t.Errorf("unexpected alert for %q", a.SessionID)
	}
}
