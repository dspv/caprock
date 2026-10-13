package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// InboxItem is one thing saved for later (migration 0053): a note, a link or
// a photo, from the phone or the machine, to start a chat from.
type InboxItem struct {
	ID   int64  `json:"id"`
	Text string `json:"text"`
	// Files are paths under <data_dir>/inbox, written by the daemon.
	Files []string `json:"files"`
	// ProjectID is the project it was saved to; 0 means the Inbox itself.
	ProjectID int64 `json:"project_id,omitempty"`
	// ProjectRoot and ProjectName are the project's, joined in when listed.
	ProjectRoot string `json:"project_root,omitempty"`
	ProjectName string `json:"project_name,omitempty"`
	// FromDevice is the paired device's name; empty when saved on the machine.
	FromDevice string `json:"from_device,omitempty"`
	CreatedAt  int64  `json:"created_at"`
}

// ErrInboxNotFound is returned for an id no row has.
var ErrInboxNotFound = errors.New("no such saved item")

const inboxCols = `i.id, i.text, i.files, COALESCE(i.project_id, 0), COALESCE(p.root, ''), COALESCE(p.name, ''), i.from_device, i.created_at`

func scanInbox(sc interface{ Scan(...any) error }) (InboxItem, error) {
	var v InboxItem
	var files string
	if err := sc.Scan(&v.ID, &v.Text, &files, &v.ProjectID, &v.ProjectRoot, &v.ProjectName, &v.FromDevice, &v.CreatedAt); err != nil {
		return v, err
	}
	// A column only the daemon writes; a value that does not parse reads as
	// no files rather than failing the whole list.
	if json.Unmarshal([]byte(files), &v.Files) != nil || v.Files == nil {
		v.Files = []string{}
	}
	return v, nil
}

// ListInbox returns the saved items, newest first.
func ListInbox(ctx context.Context, q Querier) ([]InboxItem, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+inboxCols+` FROM inbox i LEFT JOIN projects p ON p.id = i.project_id ORDER BY i.created_at DESC, i.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []InboxItem{}
	for rows.Next() {
		v, err := scanInbox(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// CountInbox is how many items there are, for the cap.
func CountInbox(ctx context.Context, q Querier) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM inbox`).Scan(&n)
	return n, err
}

// GetInboxItem returns one item; ErrInboxNotFound when unknown.
func GetInboxItem(ctx context.Context, q Querier, id int64) (InboxItem, error) {
	v, err := scanInbox(q.QueryRowContext(ctx, `SELECT `+inboxCols+` FROM inbox i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return InboxItem{}, ErrInboxNotFound
	}
	return v, err
}

// InsertInboxItem adds an item and returns it as listed.
func InsertInboxItem(ctx context.Context, q Querier, v InboxItem, now int64) (InboxItem, error) {
	files := v.Files
	if files == nil {
		files = []string{}
	}
	b, err := json.Marshal(files)
	if err != nil {
		return InboxItem{}, err
	}
	res, err := q.ExecContext(ctx, `INSERT INTO inbox (text, files, project_id, from_device, created_at) VALUES (?, ?, ?, ?, ?)`,
		v.Text, string(b), nullID(v.ProjectID), v.FromDevice, now)
	if err != nil {
		return InboxItem{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return InboxItem{}, err
	}
	return GetInboxItem(ctx, q, id)
}

// DeleteInboxItem removes an item; ErrInboxNotFound when there was none. The
// caller removes its files.
func DeleteInboxItem(ctx context.Context, q Querier, id int64) error {
	res, err := q.ExecContext(ctx, `DELETE FROM inbox WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrInboxNotFound
	}
	return nil
}
