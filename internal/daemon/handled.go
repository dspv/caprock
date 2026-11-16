package daemon

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/store"
)

// Jarvis's Handled for you (ADR-096): every action Caprock takes on its own
// is written to jarvis_handled (migration 0082) and announced on the live
// socket, so the person who comes back sees what was done while they were
// away — and, for a move, can undo it.

// JarvisHandledFrame is the live "jarvis" frame for a new item.
type JarvisHandledFrame struct {
	Op   string            `json:"op"` // "handled"
	Item store.HandledItem `json:"item"`
}

// RecordHandled writes one thing Caprock did on its own and announces it.
// At defaults to now and Project to the session's. Callers outside this
// package (the Jarvis brain's auto-answers, kind store.HandledAutoAnswer)
// use it as the rest do; an error is logged here and returned, and never
// undoes the action it records.
func (d *Daemon) RecordHandled(ctx context.Context, it store.HandledItem) (store.HandledItem, error) {
	if it.At <= 0 {
		it.At = time.Now().UnixMilli()
		if d.rec != nil {
			it.At = d.rec.Now().UnixMilli()
		}
	}
	if it.Project == "" && it.SessionID != "" {
		s, err := store.GetSession(ctx, d.store.DB(), it.SessionID)
		if err == nil {
			it.Project = s.Project
		} else if !errors.Is(err, sql.ErrNoRows) {
			d.log.Warn("handled: could not read the session", "component", "jarvis", "session_id", it.SessionID, "err", err)
		}
	}
	it, err := store.AddHandled(ctx, d.store.DB(), it)
	if err != nil {
		d.log.Warn("handled: could not record", "component", "jarvis", "kind", it.Kind, "err", err)
		return it, err
	}
	if d.bus != nil {
		d.bus.Publish(bus.Frame{Type: bus.FrameJarvis, Data: JarvisHandledFrame{Op: "handled", Item: it}})
	}
	return it, nil
}

// plainDuration says a duration in plain words, to the minute: "45 min", "2 h",
// "1 h 30 min".
func plainDuration(d time.Duration) string {
	m := int(d.Round(time.Minute) / time.Minute)
	switch {
	case m < 60:
		return strconv.Itoa(max(m, 1)) + " min"
	case m%60 == 0:
		return strconv.Itoa(m/60) + " h"
	}
	return strconv.Itoa(m/60) + " h " + strconv.Itoa(m%60) + " min"
}
