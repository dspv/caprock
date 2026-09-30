package daemon

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// Interrupted is the sessions that were running when Caprock last stopped and
// were gone when it came back — a reboot, an OS update, the laptop lid.
// Somebody coming back to the machine wants exactly these, and they were
// scattered among every other ended session with nothing to tell them apart
// (FB-038).
type Interrupted struct {
	// StoppedAt is the last heartbeat of the run that stopped, unix ms: when
	// it stopped, to within a minute.
	StoppedAt int64    `json:"stopped_at"`
	IDs       []string `json:"ids"`
}

// heartbeatEvery is how often the daemon records that it is alive, and so
// how precisely a stop can be dated.
const heartbeatEvery = time.Minute

// maxInterrupted caps the list: a banner of fifty sessions is not a way back
// to any of them.
const maxInterrupted = 12

// lastAlive reads when the previous run last said it was alive; 0 when there
// was no previous run.
func (d *Daemon) lastAlive(ctx context.Context) int64 {
	v, err := d.store.GetMeta(ctx, store.MetaAliveAt)
	if err != nil || v == "" {
		return 0
	}
	ms, _ := strconv.ParseInt(v, 10, 64)
	return ms
}

// heartbeat records that the daemon is alive, now and every minute until ctx
// ends.
func (d *Daemon) heartbeat(ctx context.Context) {
	t := time.NewTicker(heartbeatEvery)
	defer t.Stop()
	for {
		if err := d.store.SetMeta(ctx, store.MetaAliveAt, strconv.FormatInt(time.Now().UnixMilli(), 10)); err != nil && ctx.Err() == nil {
			d.log.Debug("heartbeat", "component", "daemon", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// recordInterrupted keeps, of the sessions that were running when the last
// run stopped, the ones that are over now. It runs after the first sweep has
// asked every pid, so a session that outlived the stop — Caprock restarted,
// the terminal did not — is not called interrupted.
//
// An empty result leaves the previous record alone: restarting Caprock twice
// must not erase what the reboot before it interrupted. What was continued
// since drops out on read, because a continued session is live again.
func (d *Daemon) recordInterrupted(ctx context.Context, stoppedAt int64, candidates []string) {
	if stoppedAt == 0 || len(candidates) == 0 {
		return
	}
	var ids []string
	for _, id := range candidates {
		if s, err := store.GetSession(ctx, d.store.DB(), id); err == nil && s.Status == store.StatusEnded {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return
	}
	b, _ := json.Marshal(Interrupted{StoppedAt: stoppedAt, IDs: ids})
	if err := d.store.SetMeta(ctx, store.MetaInterrupted, string(b)); err != nil {
		d.log.Warn("could not record interrupted sessions", "component", "daemon", "err", err)
		return
	}
	d.log.Info("sessions interrupted by the last stop", "component", "daemon", "count", len(ids), "stopped_at", time.UnixMilli(stoppedAt).Format(time.RFC3339))
}

// interrupted is what /v1/status reports: the last record, less every session
// that has been continued since, and nothing once it is a week old.
func (d *Daemon) interrupted(ctx context.Context) *Interrupted {
	v, err := d.store.GetMeta(ctx, store.MetaInterrupted)
	if err != nil || v == "" {
		return nil
	}
	var in Interrupted
	if json.Unmarshal([]byte(v), &in) != nil || time.Since(time.UnixMilli(in.StoppedAt)) > 7*24*time.Hour {
		return nil
	}
	ids := in.IDs[:0]
	for _, id := range in.IDs {
		if s, err := store.GetSession(ctx, d.store.DB(), id); err == nil && s.Status == store.StatusEnded {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	in.IDs = ids
	return &in
}
