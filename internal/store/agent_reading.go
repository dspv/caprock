package store

import (
	"context"
	"database/sql"
	"errors"
)

// UnrecordedTurn is the usage one stored assistant turn added to the
// rollups, to be taken back out (UnrecordTurnUsage).
type UnrecordedTurn struct {
	SessionID string
	Project   string // the session's project, the last name tried
	Cwd       string // the turn's own cwd, as rollup.Record filed it
	Day       string // local day the turn was filed under
	Model     string
	TokensIn  int64
	TokensOut int64
	CostUSD   float64
	// Turn is true when the row itself goes, so session_stats counts one
	// turn fewer; false when only its usage is cleared.
	Turn bool
}

// UnrecordTurnUsage takes one turn's usage back out of session_stats and
// daily_stats — the inverse of what rollup.Record added for it — as
// RemoveSession does for a whole session. It is how a reader that keeps
// another program's running totals (Cursor's) re-files usage it filed under
// the wrong model: the usage comes out here and is recorded again under the
// right one. A day row it cannot find (renamed since) is left as it is.
func UnrecordTurnUsage(ctx context.Context, q Querier, t UnrecordedTurn) error {
	d := Stats{SessionID: t.SessionID, TokensIn: -t.TokensIn, TokensOut: -t.TokensOut, CostUSD: -t.CostUSD}
	if t.Turn {
		d.Turns = -1
	}
	if _, err := AddStats(ctx, q, d); err != nil {
		return err
	}
	_, err := subtractDayTurns(ctx, q, RemovalCandidate{SessionID: t.SessionID, Project: t.Project},
		dayTurns{day: t.Day, model: t.Model, cwd: t.Cwd, tokens: t.TokensIn + t.TokensOut, cost: t.CostUSD})
	return err
}

// ContextReading is an agent's own measure of how full a session's context
// window is, carried on a turn's payload as `context_tokens` and
// `context_window`, and as `context_pct` (the share of the window used), by
// an agent that records one (Cursor). Cursor's November 2025 builds keep
// only the share, so a reading may have a Pct and no Tokens. Claude Code's
// fill is worked out from a turn's tokens instead (api.contextFill).
type ContextReading struct {
	Tokens int64 // 0 when the agent did not say
	Window int64 // 0 when the agent did not say
	// Pct is the share of the window used, in percent, when HasPct.
	Pct    float64
	HasPct bool
	Model  string
	At     int64 // unix ms of the turn that carried it
}

// readingScan bounds how many of a session's newest events are looked at
// for a reading, as mainTurnScan bounds LastMainTurn.
const readingScan = 5000

// LastContextReading is the newest main-thread turn of a session that
// carries an agent's own context reading.
func LastContextReading(ctx context.Context, q Querier, sessionID string) (ContextReading, bool, error) {
	var r ContextReading
	var pct sql.NullFloat64
	err := q.QueryRowContext(ctx, `
		SELECT e.ts, COALESCE(e.model, json_extract(`+ZPayloadE+`,'$.model'), ''),
		       COALESCE(json_extract(`+ZPayloadE+`,'$.context_tokens'), 0),
		       COALESCE(json_extract(`+ZPayloadE+`,'$.context_window'), 0),
		       json_extract(`+ZPayloadE+`,'$.context_pct')
		  FROM (SELECT * FROM events WHERE sid = (SELECT sid FROM sessions WHERE session_id = ?)
		         ORDER BY ts DESC, id DESC LIMIT ?) e
		 WHERE e.kind IN ('turn.user','turn.assistant') AND COALESCE(e.agent_id,'') = ''
		   AND (json_extract(`+ZPayloadE+`,'$.context_tokens') > 0
		        OR json_extract(`+ZPayloadE+`,'$.context_pct') IS NOT NULL)
		 ORDER BY e.ts DESC, e.id DESC LIMIT 1`, sessionID, readingScan).Scan(&r.At, &r.Model, &r.Tokens, &r.Window, &pct)
	r.Pct, r.HasPct = pct.Float64, pct.Valid
	if errors.Is(err, sql.ErrNoRows) {
		return ContextReading{}, false, nil
	}
	if err != nil {
		return ContextReading{}, false, err
	}
	return r, true, nil
}
