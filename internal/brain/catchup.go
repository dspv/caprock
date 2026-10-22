package brain

import (
	"context"
	"strings"

	"github.com/dspv/caprock/internal/store"
)

// The catch-up. Until 2026-10-22 a read of a session with more unread prose
// than one read sends kept only the newest MaxInputChars and moved the
// cursor past the rest, so the older part was never read. Migration 0068
// lists every read made before it as a possible gap; FindGaps measures each
// by re-running the old cut against the stored events, and the reader goes
// through what was skipped, in chunks, oldest first, when no session waits.

// Before 2026-10-22, a read fetched the newest oldPassages turns and clipped
// a prompt at oldPromptChars; the cut is re-run with those.
const (
	oldPassages    = 400
	oldPromptChars = 600
)

// earlierPart is put before a catch-up read's prompt, so the model knows
// the later part of the session was read already.
const earlierPart = "This is an earlier part of a session whose later part was already read; skip what that later part would have settled.\n"

// gapsPerPick is how many pending gaps a wake looks through for one that is
// not waiting out a failure.
const gapsPerPick = 50

// oldFirstSent re-runs the cut a read made before 2026-10-22 on what it had
// in front of it (store.BrainOldWindow) and returns the lowest event id it
// sent; 0 when it sent nothing.
func oldFirstSent(passages []store.BrainPassage) int64 {
	type line struct {
		id int64
		n  int
	}
	var lines []line
	for _, p := range passages {
		t := strings.Join(strings.Fields(p.Text), " ")
		if t == "" {
			continue
		}
		if p.User {
			t = clip(t, oldPromptChars)
		} else {
			t = clip(t, answerChars)
		}
		lines = append(lines, line{p.EventID, len(t)})
	}
	// Newest first until the budget is spent, as the old read did.
	total, keep := 0, len(lines)
	for i := len(lines) - 1; i >= 0; i-- {
		total += lines[i].n + 16
		if total > MaxInputChars {
			break
		}
		keep = i
	}
	var first int64
	for _, l := range lines[keep:] {
		if first == 0 || l.id < first {
			first = l.id
		}
	}
	return first
}

// MeasureGap finds what one past read skipped: the last event of the span
// it never sent (0 when it skipped nothing) and how many reads that span
// takes now.
func MeasureGap(ctx context.Context, q store.Querier, g store.BrainGap) (to int64, reads int, err error) {
	if g.RunThrough <= g.FromEventID {
		return 0, 0, nil
	}
	window, err := store.BrainOldWindow(ctx, q, g.SessionID, g.FromEventID, g.RunThrough, oldPassages)
	if err != nil {
		return 0, 0, err
	}
	first := oldFirstSent(window)
	if first == 0 || first-1 <= g.FromEventID {
		return 0, 0, nil
	}
	to = first - 1
	c := store.BrainCandidate{SessionID: g.SessionID, Cursor: g.FromEventID, MaxEventID: to}
	for {
		in, through, err := chunk(ctx, q, c, nil)
		if err != nil {
			return 0, 0, err
		}
		if len(in.Passages) > 0 {
			reads++
		}
		if through <= c.Cursor || through >= c.MaxEventID {
			break
		}
		c.Cursor = through
	}
	if reads == 0 {
		// Only empty or machine-made turns: nothing to read.
		return 0, 0, nil
	}
	return to, reads, nil
}

// FindGaps measures the gaps migration 0068 listed and not measured yet:
// each gets its span and its reads, or is deleted when its read skipped
// nothing. Done once; a later call finds nothing to do.
func (e *Engine) FindGaps(ctx context.Context) error {
	db := e.Store.DB()
	gaps, err := store.UnmeasuredBrainGaps(ctx, db)
	if err != nil || len(gaps) == 0 {
		return err
	}
	found, reads := 0, 0
	for _, g := range gaps {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		to, n, err := MeasureGap(ctx, db, g)
		if err != nil {
			return err
		}
		if err := store.MeasureBrainGap(ctx, db, g.ID, to, n, e.now().UnixMilli()); err != nil {
			return err
		}
		if n > 0 {
			found++
			reads += n
		}
	}
	e.log().Info("second brain: measured what past reads skipped", "component", "brain", "reads", len(gaps), "gaps", found, "catch_up_reads", reads)
	return nil
}

// nextGap is the oldest pending gap not waiting out a failure.
func (e *Engine) nextGap(ctx context.Context) (store.BrainGap, bool, error) {
	gaps, err := store.PendingBrainGaps(ctx, e.Store.DB(), gapsPerPick)
	if err != nil {
		return store.BrainGap{}, false, err
	}
	now := e.now().UnixMilli()
	for _, g := range gaps {
		if g.Attempts > 0 && now < g.UpdatedAt+(retryAfter<<(g.Attempts-1)).Milliseconds() {
			continue
		}
		return g, true, nil
	}
	return store.BrainGap{}, false, nil
}

// readGaps spends what is left of a wake's Batch calls on the catch-up,
// within the daily limit, and returns the wake's reads in all.
func (e *Engine) readGaps(ctx context.Context, read int) (int, error) {
	for read < Batch {
		if err := ctx.Err(); err != nil {
			return read, err
		}
		if !e.Enabled() {
			return read, nil
		}
		if e.spent(ctx) >= e.dailyCap() {
			e.setError("today's token limit is reached; reading resumes as the day rolls over")
			return read, nil
		}
		g, ok, err := e.nextGap(ctx)
		if err != nil || !ok {
			return read, err
		}
		did, err := e.readGap(ctx, g)
		if did {
			read++
		}
		if err != nil {
			e.setError(err.Error())
			e.log().Warn("second brain: a catch-up read failed", "component", "brain", "session", g.SessionID, "err", err)
			if !did {
				// Not a failed call but a failed lookup: the wake says so.
				return read, err
			}
		}
	}
	return read, nil
}

// readGap reads the next chunk of a gap, oldest first, with the session's
// project as a regular read has it. A chunk with too little to say is
// marked read: the prose after it was read long ago, so there is nothing
// to wait for. did is true when claude was called.
func (e *Engine) readGap(ctx context.Context, g store.BrainGap) (did bool, err error) {
	db := e.Store.DB()
	now := e.now().UnixMilli()
	c, _, err := store.BrainSessionCandidate(ctx, db, g.SessionID)
	if err != nil {
		return false, err
	}
	c.Project = memoryProject(ctx, c)
	c.Cursor, c.MaxEventID = g.Cursor, g.ToEventID
	topics, err := store.BrainEntityTitles(ctx, db, store.BrainTopic, topicsSent)
	if err != nil {
		return false, err
	}
	in, upTo, err := chunk(ctx, db, c, topics)
	if err != nil {
		return false, err
	}
	if len(in.Passages) == 0 {
		if upTo <= g.Cursor || upTo >= g.ToEventID {
			return false, store.FinishBrainGap(ctx, db, g.ID, now)
		}
		return false, store.AdvanceBrainGap(ctx, db, g.ID, upTo, now)
	}
	run := store.BrainRun{SessionID: g.SessionID, FromEventID: g.Cursor, ThroughEventID: upTo, StartedAt: now, Model: e.model(), GapID: g.ID}
	if !in.WorthReading() {
		run.Status, run.FinishedAt = store.BrainRunSkipped, now
		return false, e.Store.WithTx(ctx, func(q store.Querier) error {
			if _, err := store.InsertBrainRun(ctx, q, run); err != nil {
				return err
			}
			return store.AdvanceBrainGap(ctx, q, g.ID, upTo, now)
		})
	}
	in.Prompt = earlierPart + in.Prompt
	err = e.ask(ctx, c, in, run, func(q store.Querier) error {
		return store.AdvanceBrainGap(ctx, q, g.ID, upTo, e.now().UnixMilli())
	})
	if err != nil && ctx.Err() == nil {
		if ferr := store.FailBrainGap(ctx, db, g.ID, clip(err.Error(), 500), MaxFailures, e.now().UnixMilli()); ferr != nil {
			return true, ferr
		}
	}
	return true, err
}

// catchUpSkipped is the status's catch-up of skipped text, nil when no
// gap is left to read. Its days left are an estimate from the mean tokens
// of the catch-up reads so far (before the first, a full read's estimate),
// as if the catch-up had the whole limit.
func (e *Engine) catchUpSkipped(ctx context.Context) *CatchUp {
	db := e.Store.DB()
	done, total, left, err := store.BrainCatchUp(ctx, db)
	if err != nil || left == 0 {
		return nil
	}
	cu := &CatchUp{Kind: CatchUpSkipped, Done: done, Total: total}
	per, _ := store.BrainGapTokensPerRead(ctx, db)
	if per <= 0 {
		per = MaxInputChars/4 + OverheadTokens + 400
	}
	if rest := int64(total - done); rest > 0 {
		limit := e.dailyCap()
		cu.DaysLeft = int((rest*per + limit - 1) / limit)
	}
	return cu
}
