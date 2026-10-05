package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// RemovalCandidate is a session as the remove commands list it: enough to
// tell a test run's leftovers from real work before anything is deleted.
type RemovalCandidate struct {
	SessionID   string  `json:"session_id"`
	Cwd         string  `json:"cwd"`
	Project     string  `json:"project"`
	Agent       string  `json:"agent"`
	Status      string  `json:"status"`
	Owned       bool    `json:"owned"`
	LastEventAt int64   `json:"last_event_at"`
	Turns       int64   `json:"turns"`
	CostUSD     float64 `json:"cost_usd"`
}

// ErrRemovedSession is returned by the recorder for an event of a session the
// owner removed; it is not a failure, the event is simply not recorded.
var ErrRemovedSession = errors.New("session was removed from Caprock")

// IsRemoved reports whether the owner removed this session (migration 0040).
func IsRemoved(ctx context.Context, q Querier, sessionID string) (bool, error) {
	var one int
	err := q.QueryRowContext(ctx, `SELECT 1 FROM removed_sessions WHERE session_id = ?`, sessionID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// FindRemovalCandidates lists the sessions named by ids, or every session
// whose working directory is cwdPrefix or lies under it. One of the two must
// be given: an empty filter matching everything is never what anyone meant.
func FindRemovalCandidates(ctx context.Context, q Querier, ids []string, cwdPrefix string) ([]RemovalCandidate, error) {
	const cols = `SELECT s.session_id, COALESCE(s.cwd,''), COALESCE(s.project,''), COALESCE(s.agent,''), s.status,
		COALESCE(s.owned,0), COALESCE(s.last_event_at,0), COALESCE(st.turns,0), COALESCE(st.cost_usd,0)
		FROM sessions s LEFT JOIN session_stats st ON st.session_id = s.session_id`
	var rows *sql.Rows
	var err error
	switch {
	case len(ids) > 0:
		marks := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
		args := make([]any, len(ids))
		for i, id := range ids {
			args[i] = id
		}
		rows, err = q.QueryContext(ctx, cols+` WHERE s.session_id IN (`+marks+`) ORDER BY s.last_event_at`, args...)
	case strings.TrimSpace(cwdPrefix) != "":
		p := strings.TrimRight(cwdPrefix, `/\`)
		rows, err = q.QueryContext(ctx, cols+` WHERE s.cwd = ? OR substr(s.cwd, 1, ?) = ? OR substr(s.cwd, 1, ?) = ?
			ORDER BY s.last_event_at`, p, len(p)+1, p+"/", len(p)+1, p+`\`)
	default:
		return nil, errors.New("name the sessions to remove, or a folder whose sessions to remove")
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RemovalCandidate
	for rows.Next() {
		var c RemovalCandidate
		var owned int
		if err := rows.Scan(&c.SessionID, &c.Cwd, &c.Project, &c.Agent, &c.Status, &owned, &c.LastEventAt, &c.Turns, &c.CostUSD); err != nil {
			return nil, err
		}
		c.Owned = owned == 1
		out = append(out, c)
	}
	return out, rows.Err()
}

// dayTurns is what a session added to one daily_stats row: its turns of one
// model on one day, from one working directory.
type dayTurns struct {
	day, model, cwd string
	tokens          int64
	cost            float64
}

// RemoveSession deletes a session, its events and everything built from them,
// and records it in removed_sessions so the recorder never stores it again
// (ADR-037). Run it inside one transaction.
//
// daily_stats is shared with every other session of the same day, project and
// model, so the session's turns are taken back out of it rather than the rows
// deleted — the inverse of what rollup.Record added, as codex.removeRows
// does. It returns the cost it could not find a row to take out of, which is
// zero unless a turn's day row was rebuilt under another project name since.
func RemoveSession(ctx context.Context, q Querier, c RemovalCandidate, loc *time.Location, nowMs int64) (float64, error) {
	if loc == nil {
		loc = time.Local
	}
	groups, err := sessionDayTurns(ctx, q, c.SessionID, loc)
	if err != nil {
		return 0, err
	}
	var missed float64
	for _, g := range groups {
		ok, err := subtractDayTurns(ctx, q, c, g)
		if err != nil {
			return 0, err
		}
		if !ok {
			missed += g.cost
		}
	}
	if err := uncountDailySessions(ctx, q, c.SessionID); err != nil {
		return 0, err
	}
	for _, stmt := range []string{
		`DELETE FROM events WHERE session_id = ?`,
		`DELETE FROM session_stats WHERE session_id = ?`,
		`DELETE FROM session_files WHERE session_id = ?`,
		`DELETE FROM session_prs WHERE session_id = ?`,
		`DELETE FROM throttle_observations WHERE session_id = ?`,
		`DELETE FROM forced_continues WHERE session_id = ?`,
		`DELETE FROM pending_permissions WHERE session_id = ?`,
		`DELETE FROM sessions WHERE session_id = ?`,
	} {
		if _, err := q.ExecContext(ctx, stmt, c.SessionID); err != nil {
			return 0, fmt.Errorf("remove session %s: %w", c.SessionID, err)
		}
	}
	_, err = q.ExecContext(ctx, `INSERT INTO removed_sessions(session_id, removed_at, cwd, cost_usd) VALUES(?, ?, ?, ?)
		ON CONFLICT(session_id) DO NOTHING`, c.SessionID, nowMs, c.Cwd, c.CostUSD)
	return missed, err
}

// sessionDayTurns groups the session's counted turns the way rollup.Record
// filed them into daily_stats: by local day, model and the turn's own cwd.
func sessionDayTurns(ctx context.Context, q Querier, sessionID string, loc *time.Location) ([]dayTurns, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT ts, COALESCE(model,''), payload,
		       COALESCE(tokens_in,0) + COALESCE(tokens_out,0) + COALESCE(cache_read,0) + COALESCE(cache_write,0),
		       COALESCE(cost_usd,0)
		  FROM events
		 WHERE session_id = ? AND kind = 'turn.assistant' AND internal = 0`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	idx := map[[3]string]int{}
	var out []dayTurns
	for rows.Next() {
		var ts, tokens int64
		var model, payload string
		var cost float64
		if err := rows.Scan(&ts, &model, &payload, &tokens, &cost); err != nil {
			return nil, err
		}
		var p struct {
			Cwd string `json:"cwd"`
		}
		_ = json.Unmarshal([]byte(payload), &p)
		k := [3]string{time.UnixMilli(ts).In(loc).Format("2006-01-02"), model, p.Cwd}
		i, ok := idx[k]
		if !ok {
			i = len(out)
			idx[k] = i
			out = append(out, dayTurns{day: k[0], model: k[1], cwd: k[2]})
		}
		out[i].tokens += tokens
		out[i].cost += cost
	}
	return out, rows.Err()
}

// subtractDayTurns takes one group out of the daily_stats row it was added
// to. The project Record used is not stored with the turn, so the candidates
// are tried in order of certainty: the project the session was counted under
// that day (daily_sessions), the turn's own cwd as it resolves today, and the
// session's project. UPDATE, never AddDaily: a negative upsert into a row that
// is not there would create one.
func subtractDayTurns(ctx context.Context, q Querier, c RemovalCandidate, g dayTurns) (bool, error) {
	if g.tokens == 0 && g.cost == 0 {
		return true, nil
	}
	var projects []string
	rows, err := q.QueryContext(ctx, `SELECT project FROM daily_sessions WHERE day = ? AND session_id = ?`, g.day, c.SessionID)
	if err != nil {
		return false, err
	}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			_ = rows.Close()
			return false, err
		}
		projects = append(projects, p)
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	projects = append(projects, ProjectFromCwd(g.cwd), c.Project)
	tried := map[string]bool{}
	for _, p := range projects {
		if tried[p] {
			continue
		}
		tried[p] = true
		res, err := q.ExecContext(ctx,
			`UPDATE daily_stats SET tokens_total = tokens_total - ?, cost_usd = cost_usd - ?
			  WHERE day = ? AND project = ? AND model = ?`, g.tokens, g.cost, g.day, p, g.model)
		if err != nil {
			return false, err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			return true, nil
		}
	}
	return false, nil
}

// uncountDailySessions takes the session out of each day's session count.
// Record added one to a row of that day and project; summing a day's rows is
// how the count is read, so a row of the same project is preferred and any
// row of the day will do.
func uncountDailySessions(ctx context.Context, q Querier, sessionID string) error {
	rows, err := q.QueryContext(ctx, `SELECT day, project FROM daily_sessions WHERE session_id = ?`, sessionID)
	if err != nil {
		return err
	}
	var marks [][2]string
	for rows.Next() {
		var m [2]string
		if err := rows.Scan(&m[0], &m[1]); err != nil {
			_ = rows.Close()
			return err
		}
		marks = append(marks, m)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, m := range marks {
		if _, err := q.ExecContext(ctx, `
			UPDATE daily_stats SET sessions = sessions - 1
			 WHERE rowid = (SELECT rowid FROM daily_stats WHERE day = ? AND sessions > 0
			                 ORDER BY (project = ?) DESC LIMIT 1)`, m[0], m[1]); err != nil {
			return err
		}
	}
	_, err = q.ExecContext(ctx, `DELETE FROM daily_sessions WHERE session_id = ?`, sessionID)
	return err
}
