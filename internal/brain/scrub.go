package brain

import (
	"context"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// ScrubOnce redacts, once per database, the credentials and payment details
// in the memories and note excerpts kept before the privacy filter
// (store.ScrubBrainSecrets), in one transaction, and marks it done in meta
// (store.MetaBrainScrubbed). It runs whether or not the extraction is on:
// memories made earlier, by hand or imported, are handed on all the same.
// The log line holds counts by kind, never a value. A failure is logged and
// tried again on the next start.
func (e *Engine) ScrubOnce(ctx context.Context) {
	if e.Store == nil {
		return
	}
	if done, _ := e.Store.GetMeta(ctx, store.MetaBrainScrubbed); done == "1" {
		return
	}
	start := time.Now()
	var nodes, notes int
	var kinds string
	err := e.Store.WithTx(ctx, func(q store.Querier) error {
		n, x, counts, err := store.ScrubBrainSecrets(ctx, q, e.now().UnixMilli())
		nodes, notes, kinds = n, x, counts.String()
		return err
	})
	if err != nil {
		if ctx.Err() == nil {
			e.log().Warn("second brain: the privacy scrub failed", "component", "brain", "err", err)
		}
		return
	}
	if err := e.Store.SetMeta(ctx, store.MetaBrainScrubbed, "1"); err != nil {
		return
	}
	e.log().Info("second brain: privacy scrub done", "component", "brain",
		"nodes", nodes, "notes", notes, "redacted", kinds, "took_ms", time.Since(start).Milliseconds())
}
