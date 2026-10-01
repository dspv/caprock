package codex

import (
	"context"
	"fmt"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// Two mistakes in what earlier versions stored, both repaired here from the
// transcripts — the only place the answer exists. The rows themselves cannot
// say which file wrote them: an imported thread's turns look like any other
// Codex turn, and a subagent's rows sit in its parent's session under keys
// its parent's file also produces. So this is code that reads the rollouts,
// not a migration, the same reason repriceSession and backfillText are.
//
//   - Threads Codex Desktop imported from Claude Code were counted as Codex
//     spend. Their token reports are Claude Code's work replayed, which
//     Caprock already counts from Claude Code's own transcripts. On the owner's
//     machine: 138 turns in 95 threads, 21.5M tokens, $26.70 counted twice.
//   - A subagent's turns collided with its parent's on the same line number,
//     and the file read second lost them (see subagentKey).
//
// Every removal moves session_stats and daily_stats by the same amount in the
// same transaction, as repriceSession and rollup.PriceUnpriced do, so no screen
// reading the rollups disagrees with the events they were built from.

// storedRow is one stored Codex event, with what is needed to take it back out
// of the totals it was added to.
type storedRow struct {
	id       int64
	ts       int64
	session  string
	key      string
	kind     string
	model    string
	internal bool
	cwd      string
	tokens   event.TokenDelta
	cost     float64
}

func (in *Ingester) codexRows(ctx context.Context, session string) ([]storedRow, error) {
	rows, err := in.rec.Store.DB().QueryContext(ctx, `
		SELECT id, ts, session_id, COALESCE(key,''), kind, COALESCE(model,''), internal,
		       CASE WHEN json_valid(payload) THEN COALESCE(json_extract(payload,'$.cwd'),'') ELSE '' END,
		       COALESCE(tokens_in,0), COALESCE(tokens_out,0), COALESCE(cache_read,0), COALESCE(cache_write,0),
		       COALESCE(cost_usd,0)
		  FROM events WHERE session_id = ? AND source = ?`, session, string(event.SourceCodex))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []storedRow
	for rows.Next() {
		var r storedRow
		var internal int
		if err := rows.Scan(&r.id, &r.ts, &r.session, &r.key, &r.kind, &r.model, &internal, &r.cwd,
			&r.tokens.In, &r.tokens.Out, &r.tokens.CacheRead, &r.tokens.CacheWrite, &r.cost); err != nil {
			return nil, err
		}
		r.internal = internal == 1
		out = append(out, r)
	}
	return out, rows.Err()
}

// removeRows deletes events and takes each back out of session_stats and
// daily_stats — the exact inverse of what rollup.Record added for it. An
// internal event added nothing, so it takes nothing away. Files a tool call
// touched stay in session_files: the same call is recorded again under its new
// key for a subagent, and an imported thread recorded no tool calls.
func (in *Ingester) removeRows(ctx context.Context, q store.Querier, rows []storedRow) error {
	loc := in.rec.Location
	if loc == nil {
		loc = time.Local
	}
	for _, r := range rows {
		res, err := q.ExecContext(ctx, `DELETE FROM events WHERE id = ?`, r.id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 || r.internal {
			continue
		}
		switch r.kind {
		case string(event.KindTurnAssistant):
			if _, err := store.AddStats(ctx, q, store.Stats{
				SessionID: r.session, Turns: -1,
				TokensIn: -r.tokens.In, TokensOut: -r.tokens.Out,
				CacheRead: -r.tokens.CacheRead, CacheWrite: -r.tokens.CacheWrite,
				CostUSD: -r.cost,
			}); err != nil {
				return err
			}
			day := time.UnixMilli(r.ts).In(loc).Format("2006-01-02")
			if err := subtractDaily(ctx, q, day, r, in.projectOf(ctx, q, r)); err != nil {
				return err
			}
		case string(event.KindToolPre):
			if _, err := store.AddStats(ctx, q, store.Stats{SessionID: r.session, ToolCalls: -1}); err != nil {
				return err
			}
		}
	}
	return nil
}

// projectOf is the project rollup.Record filed the turn's day under: the one
// its own cwd resolves to, or the session's when that is empty.
func (in *Ingester) projectOf(ctx context.Context, q store.Querier, r storedRow) []string {
	var out []string
	if p := store.ProjectFromCwd(r.cwd); p != "" {
		out = append(out, p)
	}
	var p string
	if err := q.QueryRowContext(ctx, `SELECT COALESCE(project,'') FROM sessions WHERE session_id = ?`, r.session).Scan(&p); err == nil {
		out = append(out, p)
	}
	return out
}

// subtractDaily takes a turn out of its day's row. UPDATE, never AddDaily: a
// negative upsert into a row that is not there would create one. The project
// is tried as the turn's cwd resolves today and then as the session's, because
// a directory that has since moved can resolve differently; a turn whose row
// is found under neither is left, and the day stays as it was rather than
// losing figures from a row they were never in.
func subtractDaily(ctx context.Context, q store.Querier, day string, r storedRow, projects []string) error {
	tokens := r.tokens.Total()
	for _, p := range projects {
		res, err := q.ExecContext(ctx,
			`UPDATE daily_stats SET tokens_total = tokens_total - ?, cost_usd = cost_usd - ?
			  WHERE day = ? AND project = ? AND model = ?`,
			tokens, r.cost, day, p, r.model)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			return nil
		}
	}
	return nil
}

// purgeImported removes everything an earlier version stored for a thread
// Codex imported from another agent, and the session itself once nothing of
// it is left. The ingest no longer records these threads at all (session), so
// this finds nothing on a database that never held one, at the cost of one
// indexed lookup per imported file read.
func (in *Ingester) purgeImported(ctx context.Context, s *Session) (int, error) {
	if in.rec == nil || in.rec.Store == nil {
		return 0, nil
	}
	rows, err := in.codexRows(ctx, s.ID)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	loc := in.rec.Location
	if loc == nil {
		loc = time.Local
	}
	// The day's session count: rollup.Record added it to the row of the
	// session's first counted turn that day.
	type first struct {
		ts    int64
		model string
		cwd   string
	}
	firsts := map[string]first{}
	for _, r := range rows {
		if r.internal || r.kind != string(event.KindTurnAssistant) {
			continue
		}
		day := time.UnixMilli(r.ts).In(loc).Format("2006-01-02")
		if f, ok := firsts[day]; !ok || r.ts < f.ts {
			firsts[day] = first{ts: r.ts, model: r.model, cwd: r.cwd}
		}
	}
	err = in.rec.Store.WithTx(ctx, func(q store.Querier) error {
		if err := in.removeRows(ctx, q, rows); err != nil {
			return err
		}
		for day, f := range firsts {
			for _, p := range in.projectOf(ctx, q, storedRow{session: s.ID, cwd: f.cwd}) {
				res, err := q.ExecContext(ctx,
					`DELETE FROM daily_sessions WHERE day = ? AND project = ? AND session_id = ?`, day, p, s.ID)
				if err != nil {
					return err
				}
				if n, _ := res.RowsAffected(); n == 0 {
					continue
				}
				if _, err := q.ExecContext(ctx,
					`UPDATE daily_stats SET sessions = sessions - 1
					  WHERE day = ? AND project = ? AND model = ? AND sessions > 0`, day, p, f.model); err != nil {
					return err
				}
				break
			}
		}
		var left int
		if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE session_id = ?`, s.ID).Scan(&left); err != nil {
			return err
		}
		if left > 0 {
			return nil
		}
		// Nothing of it remains: the card would be an empty Codex twin of
		// the Claude Code session it was imported from.
		for _, stmt := range []string{
			`DELETE FROM session_stats WHERE session_id = ?`,
			`DELETE FROM session_files WHERE session_id = ?`,
			`DELETE FROM daily_sessions WHERE session_id = ?`,
			`DELETE FROM sessions WHERE session_id = ? AND agent = 'codex'`,
		} {
			if _, err := q.ExecContext(ctx, stmt, s.ID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("purge imported codex thread %s: %w", s.ID, err)
	}
	return len(rows), nil
}

// dropLegacySubagentRows removes the rows an earlier version stored for a
// subagent's records under the line-number key its parent's file also uses.
// A row is the subagent's only when its key AND timestamp match one of the
// subagent's records and do not match the parent's record on that line — the
// parent's rows are left exactly as they are. They are recorded again under
// the subagent's own keys straight after.
func (in *Ingester) dropLegacySubagentRows(ctx context.Context, sub *Session, parent *Session) (int, error) {
	want := map[string]int64{}
	for _, t := range sub.Turns {
		want[LegacyKey(t.Line, "turn")] = t.At.UnixMilli()
	}
	for _, c := range sub.Tools {
		want[LegacyKey(c.Line, "tool")] = c.At.UnixMilli()
	}
	if len(want) == 0 {
		return 0, nil
	}
	parentAt := map[string]int64{}
	if parent != nil {
		for _, t := range parent.Turns {
			parentAt[t.Key] = t.At.UnixMilli()
		}
		for _, c := range parent.Tools {
			parentAt[c.Key] = c.At.UnixMilli()
		}
	}
	rows, err := in.codexRows(ctx, sub.ID)
	if err != nil {
		return 0, err
	}
	var drop []storedRow
	for _, r := range rows {
		ts, ok := want[r.key]
		if !ok || ts != r.ts {
			continue
		}
		if pts, ok := parentAt[r.key]; ok && pts == r.ts {
			continue // indistinguishable from the parent's own: keep it
		}
		drop = append(drop, r)
	}
	if len(drop) == 0 {
		return 0, nil
	}
	err = in.rec.Store.WithTx(ctx, func(q store.Querier) error { return in.removeRows(ctx, q, drop) })
	if err != nil {
		return 0, fmt.Errorf("drop subagent rows from %s: %w", sub.ID, err)
	}
	return len(drop), nil
}

// repairSplit runs both repairs once, over every rollout on disk.
//
// The ordinary pass cannot: it skips every file it has already read, and the
// rows to repair came from exactly those files. So each rollout is parsed once
// more. Imported threads are purged; each subagent's rows are taken out of its
// parent's line-number keys and recorded under its own; and then each parent
// file is recorded again, which brings back the parent's own turns that a
// subagent's row had been blocking (Record skips everything already stored).
// Interrupted, it runs again on the next start: every step finds nothing left
// to do the second time.
func (in *Ingester) repairSplit(ctx context.Context, files []Transcript) {
	if in.rec == nil || in.rec.Store == nil {
		return
	}
	if done, _ := in.rec.Store.GetMeta(ctx, store.MetaCodexSplitRepaired); done == "1" {
		return
	}
	start := time.Now()
	var subs []*Session
	parents := map[string]*Session{}
	needParent := map[string]bool{}
	var purged, imported, dropped, parsed int
	for _, f := range files {
		if ctx.Err() != nil {
			return
		}
		s, err := ParseFile(f.Path)
		if err != nil {
			continue
		}
		parsed++
		switch {
		case s.Imported:
			imported++
			n, err := in.purgeImported(ctx, s)
			if err != nil {
				in.log.Warn("codex imported-thread repair", "component", "codex", "session_id", s.ID, "err", err)
				return
			}
			purged += n
		case s.Subagent:
			subs = append(subs, s)
			needParent[s.ID] = true
		default:
			parents[s.ID] = s
		}
	}
	for _, sub := range subs {
		if ctx.Err() != nil {
			return
		}
		n, err := in.dropLegacySubagentRows(ctx, sub, parents[sub.ID])
		if err != nil {
			in.log.Warn("codex subagent repair", "component", "codex", "session_id", sub.ID, "err", err)
			return
		}
		dropped += n
	}
	before := in.Stats().Events
	for _, sub := range subs {
		if err := in.session(ctx, sub); err != nil {
			return
		}
	}
	for id := range needParent {
		if p := parents[id]; p != nil {
			if err := in.session(ctx, p); err != nil {
				return
			}
		}
	}
	restored := in.Stats().Events - before
	if err := in.rec.Store.SetMeta(ctx, store.MetaCodexSplitRepaired, "1"); err != nil {
		return
	}
	in.log.Info("codex imported threads and subagent turns repaired from the transcripts",
		"component", "codex", "transcripts", parsed, "imported_threads", imported,
		"imported_events_removed", purged, "subagent_rows_moved", dropped,
		"events_restored", restored, "took_ms", time.Since(start).Milliseconds())
}
