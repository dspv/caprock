package mailstore

import "context"

// DigestItem is one important conversation for the Morning summary: who
// wrote its newest inbox message and its subject. Never a body.
type DigestItem struct {
	FromName string
	FromAddr string
	Subject  string
	Date     int64
}

// Digest counts the inbox conversations that got mail at or after since
// (unix seconds) — leaving out the junk filter's catch and what the triage
// called spam — and returns, newest first, up to n of those the triage
// labelled important, with how many there are. It reads only the labels
// triage already gave: no model call (ADR-091). Ranged on messages_date.
func (s *Store) Digest(ctx context.Context, since int64, n int) (total, important int, items []DigestItem, err error) {
	rows, err := s.db.QueryContext(ctx, `WITH conv AS (
		SELECT m.account_id, m.thread_key, MAX(m.date) AS d, MAX(m.id) AS newest, MAX(m.junk) AS junk
		FROM messages m JOIN folders f ON f.id = m.folder_id
		WHERE m.date >= ? AND f.role = 'inbox'
		GROUP BY m.account_id, m.thread_key)
		SELECT COALESCE(t.category, ''), m.from_name, m.from_addr, m.subject, c.d
		FROM conv c JOIN messages m ON m.id = c.newest
		LEFT JOIN triage t ON t.account_id = c.account_id AND t.thread_key = c.thread_key
		WHERE c.junk = 0
		ORDER BY c.d DESC`, since)
	if err != nil {
		return 0, 0, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var cat string
		var it DigestItem
		if err := rows.Scan(&cat, &it.FromName, &it.FromAddr, &it.Subject, &it.Date); err != nil {
			return 0, 0, nil, err
		}
		if cat == "spam" {
			continue
		}
		total++
		if cat != "important" {
			continue
		}
		important++
		if len(items) < n {
			items = append(items, it)
		}
	}
	return total, important, items, rows.Err()
}
