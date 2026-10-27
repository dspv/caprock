package daemon

import (
	"context"
	"time"

	"github.com/dspv/caprock/internal/store"
)

const moveRetry = time.Minute

// moveEvents moves the events stored before migration 0073 into events
// (store.MoveEventsStep), a step at a time with compactPause between steps,
// then lets what waited for them start (afterMove).
func (d *Daemon) moveEvents(ctx context.Context) {
	if d.store.Moving() {
		start := time.Now()
		for {
			n, err := d.store.MoveEvents(ctx, store.MoveWindow, compactPause)
			if err == nil {
				d.log.Info("moved the events stored before the upgrade", "component", "store",
					"events", n, "took", time.Since(start).Round(time.Second))
				break
			}
			if ctx.Err() != nil {
				return
			}
			d.log.Warn("could not move older events into the upgraded table; trying again", "component", "store",
				"err", err, "in", moveRetry)
			select {
			case <-ctx.Done():
				return
			case <-time.After(moveRetry):
			}
		}
		if d.api != nil {
			d.api.ForgetAnswers()
		}
		repairTranscripts(ctx, d.store, d.log)
	}
	close(d.whole)
}

// afterMove runs f once every event is in events. What reads a whole history,
// or marks itself done over one, would see the newest rows alone while they
// move, and importers would count the rest again.
func (d *Daemon) afterMove(ctx context.Context, f func()) {
	d.goBg(func() {
		select {
		case <-d.whole:
			f()
		case <-ctx.Done():
		}
	})
}

// moving is whether events are still moving; a Daemon with no store has
// none to move.
func (d *Daemon) moving() bool { return d.store != nil && d.store.Moving() }

// MoveStatus is /v1/status's events_move: how many of the events stored
// before the upgrade are in place, of how many.
type MoveStatus struct {
	Moved int64 `json:"moved"`
	Total int64 `json:"total"`
}
