package rollup

import (
	"context"

	"github.com/dspv/caprock/internal/store"
)

// RepairSessionModels sets each session's model to the one its main thread
// last ran on, where the stored value says otherwise.
//
// Earlier versions let a subagent's turn overwrite sessions.model, so a session
// run on Opus whose last subagent ran on Haiku is stored as Haiku — on its
// card, in the session lists and in the window its context fill is measured
// against. Recording now keeps the main thread's model
// (store.SessionPatch.SubagentModel), which repairs nothing already written;
// this does.
//
// Only sessions with a main-thread turn naming a model are touched. One whose
// every turn is a subagent's (an OpenCode child session) has nothing better to
// say than what it holds. Internal turns (a Codex review) are left out, as the
// write path leaves them out. Runs once (store.MetaSessionModelRepaired).
func (r *Recorder) RepairSessionModels(ctx context.Context) (int, error) {
	if done, _ := r.Store.GetMeta(ctx, store.MetaSessionModelRepaired); done == "1" {
		return 0, nil
	}
	var n int64
	err := r.Store.WithTx(ctx, func(q store.Querier) error {
		// The marker first, which also takes the write lock (see
		// RebuildCodexDaily for what a read-then-upgrade transaction did).
		if _, err := q.ExecContext(ctx, `INSERT INTO meta(k, v) VALUES(?, '1') ON CONFLICT(k) DO UPDATE SET v = excluded.v`, store.MetaSessionModelRepaired); err != nil {
			return err
		}
		res, err := q.ExecContext(ctx, `
			WITH ranked AS (
				SELECT e.session_id, e.model,
				       ROW_NUMBER() OVER (PARTITION BY e.session_id ORDER BY e.ts DESC, e.id DESC) AS rn
				FROM events e
				WHERE e.kind = 'turn.assistant' AND e.internal = 0
				  AND COALESCE(e.model, '') != ''
				  AND `+store.MainThreadWhere+`
			)
			UPDATE sessions SET model = ranked.model
			FROM ranked
			WHERE ranked.session_id = sessions.session_id AND ranked.rn = 1
			  AND COALESCE(sessions.model, '') != ranked.model`)
		if err != nil {
			return err
		}
		n, _ = res.RowsAffected()
		return nil
	})
	if err != nil {
		return 0, err
	}
	if r.Log != nil && n > 0 {
		r.Log.Info("restored session models a subagent had overwritten", "component", "rollup", "sessions", n)
	}
	return int(n), nil
}
