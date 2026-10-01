package codex

import (
	"context"

	"github.com/dspv/caprock/internal/store"
)

// Codex writes its plan-limit windows into every `token_count` record, so the
// latest one in the newest transcript is the latest thing Codex was told about
// the plan. Caprock stores that one observation — every window in it, replacing
// the previous set — and the Cost screen shows it as Codex's, beside Claude
// Code's. Nothing is projected from it: there is no history kept and no pace
// forecast, only the measured figure and when Codex wrote it.

// limitBackfillFiles bounds how many of the newest transcripts the first pass
// opens to find a limits sample, when the store has none yet.
const limitBackfillFiles = 10

// maxResetAhead is how far past its own sample a reset may lie before it is
// treated as nonsense. The longest window is seven days; the statusline path
// uses the same eight-day bound for Claude Code's windows.
const maxResetAhead = 8 * 24 * 3600 // seconds

// windowName maps a window's length to the name Claude Code uses for the same
// window, or "" for a length we have never seen. Codex reports minutes, and
// not always round ones: CLI 0.4x wrote 299 and 10079 where later versions
// write 300 and 10080. A length outside both bands is skipped rather than
// labelled by a guess.
func windowName(minutes int) string {
	switch {
	case minutes >= 290 && minutes <= 310:
		return "five_hour"
	case minutes >= 10000 && minutes <= 10160:
		return "seven_day"
	}
	return ""
}

// limitSnapshots turns a parsed sample into rows for the store, dropping any
// window that is unrecognised or implausible.
func limitSnapshots(l *Limits) []store.RateLimitSnapshot {
	if l == nil || l.At.IsZero() {
		return nil
	}
	at := l.At.UnixMilli()
	var out []store.RateLimitSnapshot
	seen := map[string]bool{}
	for _, w := range l.Windows {
		name := windowName(w.Minutes)
		if name == "" || seen[name] {
			continue
		}
		if w.UsedPercent < 0 || w.UsedPercent > 100 {
			continue
		}
		if w.ResetsAt != 0 && w.ResetsAt > l.At.Unix()+maxResetAhead {
			continue
		}
		seen[name] = true
		out = append(out, store.RateLimitSnapshot{Window: name, Ts: at, UsedPercentage: w.UsedPercent, ResetsAt: w.ResetsAt})
	}
	return out
}

// recordLimits stores a transcript's latest sample if it is newer than the one
// already held. Best-effort: a failure costs the limits panel, never an import.
func (in *Ingester) recordLimits(ctx context.Context, s *Session) {
	if s == nil || in.rec == nil || in.rec.Store == nil {
		return
	}
	snaps := limitSnapshots(s.Limits)
	if len(snaps) == 0 {
		return
	}
	err := in.rec.Store.WithTx(ctx, func(q store.Querier) error {
		_, err := store.ReplaceRateLimits(ctx, q, store.CodexRateLimitPrefix, s.ID, snaps)
		return err
	})
	if err != nil {
		in.log.Debug("record codex plan limits", "component", "codex", "err", err)
	}
}

// backfillLimits fills the limits once, on the first pass, when the store has
// none. Transcripts read by an earlier version are remembered as read and are
// not parsed again until they change, so without this an upgrade would show no
// Codex limits until the next Codex session wrote something. Only the newest
// few files are opened, and it stops at the first that carries a sample.
func (in *Ingester) backfillLimits(ctx context.Context, files []Transcript) {
	if in.rec == nil || in.rec.Store == nil {
		return
	}
	have, err := store.RateLimitsWithPrefix(ctx, in.rec.Store.DB(), store.CodexRateLimitPrefix)
	if err != nil || len(have) > 0 {
		return
	}
	for i, f := range files {
		if i >= limitBackfillFiles || ctx.Err() != nil {
			return
		}
		s, err := ParseFile(f.Path)
		if err != nil || s.Limits == nil {
			continue
		}
		in.recordLimits(ctx, s)
		return
	}
}
