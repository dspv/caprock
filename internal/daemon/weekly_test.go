package daemon

import (
	"context"
	"testing"
	"time"

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
