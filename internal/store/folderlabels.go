package store

import "context"

// Folder labels (ADR-091, migration 0079): "work" or "personal" on a folder,
// set from New chat's Where step and shown on the Chats list. A label in
// Caprock's own database, as a session's name is; it runs nothing.

// The labels a folder may carry.
const (
	FolderLabelWork     = "work"
	FolderLabelPersonal = "personal"
)

// FolderLabel is one labelled folder.
type FolderLabel struct {
	Dir       string `json:"dir"`
	Label     string `json:"label"`
	UpdatedAt int64  `json:"updated_at"`
}

// ValidFolderLabel reports whether label may be stored. "" is not a label
// but its removal.
func ValidFolderLabel(label string) bool {
	return label == FolderLabelWork || label == FolderLabelPersonal
}

// ListFolderLabels returns every labelled folder, by path.
func ListFolderLabels(ctx context.Context, q Querier) ([]FolderLabel, error) {
	rows, err := q.QueryContext(ctx, `SELECT dir, label, updated_at FROM folder_labels ORDER BY dir`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []FolderLabel{}
	for rows.Next() {
		var l FolderLabel
		if err := rows.Scan(&l.Dir, &l.Label, &l.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// SetFolderLabel labels dir at `at` (unix ms), replacing its label; an empty
// label removes it.
func SetFolderLabel(ctx context.Context, q Querier, dir, label string, at int64) error {
	if label == "" {
		_, err := q.ExecContext(ctx, `DELETE FROM folder_labels WHERE dir = ?`, dir)
		return err
	}
	_, err := q.ExecContext(ctx, `INSERT INTO folder_labels (dir, label, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(dir) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`, dir, label, at)
	return err
}
