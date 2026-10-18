package mailstore

import (
	"context"
	"errors"
	"fmt"
)

// CleanupQuery describes the synced messages a user can review for cleanup.
// Before is a message-date cutoff in Unix milliseconds, not time spent in Trash.
type CleanupQuery struct {
	View      string `json:"view"`
	AccountID int64  `json:"account"`
	Before    int64  `json:"before"`
	MinScore  int    `json:"min_score"`
}

func (q CleanupQuery) Validate() error {
	if (q.View != "junk" && q.View != "trash") || q.AccountID < 0 || q.Before < 0 || q.MinScore < 0 || q.MinScore > 100 {
		return errors.New("invalid cleanup scope")
	}
	return nil
}

// CleanupIDs includes all matching synced messages, independent of list paging.
// Spam is the server's Junk folder plus the filter/triage catch in the Inbox.
func (s *Store) CleanupIDs(ctx context.Context, q CleanupQuery) ([]int64, error) {
	ids, _, err := s.CleanupSnapshot(ctx, q)
	return ids, err
}

// CleanupSnapshot binds local IDs to IMAP identities: SQLite may reuse a deleted ID.
func (s *Store) CleanupSnapshot(ctx context.Context, q CleanupQuery) ([]int64, map[int64]string, error) {
	if err := q.Validate(); err != nil {
		return nil, nil, err
	}
	scope := "f.role='trash'"
	if q.View == "junk" {
		scope = "(f.role='junk' OR (f.role='inbox' AND " + SpamSQL + "))"
	}
	rows, err := s.db.QueryContext(ctx, `SELECT m.id, m.account_id, m.folder_id, m.uid, f.uidvalidity FROM messages m JOIN folders f ON f.id=m.folder_id
  WHERE `+scope+` AND (?=0 OR m.account_id=?) AND (?=0 OR (m.date>0 AND m.date<?))
  AND (?=0 OR (m.junk=1 AND m.junk_score>=?)) ORDER BY m.id`,
		q.AccountID, q.AccountID, q.Before, q.Before, q.MinScore, q.MinScore)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	ids := []int64{}
	identities := make(map[int64]string)
	for rows.Next() {
		var id, account, folder, uid, validity int64
		if err := rows.Scan(&id, &account, &folder, &uid, &validity); err != nil {
			return nil, nil, err
		}
		ids = append(ids, id)
		identities[id] = CleanupIdentity(account, folder, uint32(validity), uint32(uid))
	}
	return ids, identities, rows.Err()
}

// CleanupIdentity identifies one message across local row reuse and mailbox resets.
func CleanupIdentity(account, folder int64, validity, uid uint32) string {
	return fmt.Sprintf("%d:%d:%d:%d", account, folder, validity, uid)
}
