package store

import "context"

// The Jarvis thread (migration 0083, ADR-097): what the person said to
// Jarvis and what Jarvis said back, oldest first.

// Jarvis thread roles.
const (
	JarvisRoleUser   = "user"
	JarvisRoleJarvis = "jarvis"
)

// Jarvis thread kinds: what made a row.
const (
	JarvisKindSay        = "say"
	JarvisKindReply      = "reply"
	JarvisKindDone       = "done"
	JarvisKindAutoAnswer = "auto_answer"
)

// JarvisThreadKeep is how many rows the thread keeps; older ones are pruned
// as new ones arrive.
const JarvisThreadKeep = 2000

// JarvisMessage is one row of the thread.
type JarvisMessage struct {
	ID        int64
	At        int64
	Role      string
	Kind      string
	Text      string
	Project   string
	SessionID string
	Via       string
	Pending   bool
	// Brain is true when a model ran for the row; CostUSD is what that run
	// cost as the agent reported it, 0 when unknown.
	Brain   bool
	CostUSD float64
}

// AppendJarvisMessage stores m and returns its id, pruning the thread to
// JarvisThreadKeep rows.
func AppendJarvisMessage(ctx context.Context, q Querier, m JarvisMessage) (int64, error) {
	res, err := q.ExecContext(ctx, `INSERT INTO jarvis_thread (at, role, kind, text, project, session_id, via, pending, brain, cost_usd)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, m.At, m.Role, m.Kind, m.Text, m.Project, m.SessionID, m.Via, b2i(m.Pending), b2i(m.Brain), m.CostUSD)
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	if id%100 == 0 {
		_, _ = q.ExecContext(ctx, `DELETE FROM jarvis_thread WHERE id <= ?`, id-JarvisThreadKeep)
	}
	return id, nil
}

// UpdateJarvisMessage replaces a row's text, session, project, pending flag
// and cost (a brain reply that arrived).
func UpdateJarvisMessage(ctx context.Context, q Querier, m JarvisMessage) error {
	_, err := q.ExecContext(ctx, `UPDATE jarvis_thread SET text = ?, project = ?, session_id = ?, pending = ?, brain = ?, cost_usd = ? WHERE id = ?`,
		m.Text, m.Project, m.SessionID, b2i(m.Pending), b2i(m.Brain), m.CostUSD, m.ID)
	return err
}

// JarvisThread is the newest limit rows, oldest first.
func JarvisThread(ctx context.Context, q Querier, limit int) ([]JarvisMessage, error) {
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	rows, err := q.QueryContext(ctx, `SELECT id, at, role, kind, text, project, session_id, via, pending, brain, cost_usd
		FROM (SELECT * FROM jarvis_thread ORDER BY id DESC LIMIT ?) ORDER BY id`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []JarvisMessage{}
	for rows.Next() {
		var m JarvisMessage
		var pending, brain int
		if err := rows.Scan(&m.ID, &m.At, &m.Role, &m.Kind, &m.Text, &m.Project, &m.SessionID, &m.Via, &pending, &brain, &m.CostUSD); err != nil {
			return nil, err
		}
		m.Pending, m.Brain = pending != 0, brain != 0
		out = append(out, m)
	}
	return out, rows.Err()
}

// JarvisBrainSpend is what the brain's runs cost since fromMs, as the agent
// reported it, and how many runs there were.
func JarvisBrainSpend(ctx context.Context, q Querier, fromMs int64) (usd float64, runs int, err error) {
	err = q.QueryRowContext(ctx, `SELECT COALESCE(SUM(cost_usd), 0), COUNT(*) FROM jarvis_thread WHERE at >= ? AND brain != 0`, fromMs).Scan(&usd, &runs)
	return usd, runs, err
}

// SettleJarvisPending turns the rows a restart left pending into note,
// returning how many it changed.
func SettleJarvisPending(ctx context.Context, q Querier, note string) (int64, error) {
	res, err := q.ExecContext(ctx, `UPDATE jarvis_thread SET pending = 0, text = ? WHERE pending != 0`, note)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
