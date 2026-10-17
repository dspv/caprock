package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// ModuleDoc is one document a private module keeps (migration 0061, ADR-076).
// Data is a JSON object; the store never reads inside it.
type ModuleDoc struct {
	ID        string          `json:"id"`
	Data      json.RawMessage `json:"data"`
	CreatedAt int64           `json:"created_at"`
	UpdatedAt int64           `json:"updated_at"`
}

// ErrModuleDocNotFound is returned for a document no row holds.
var ErrModuleDocNotFound = errors.New("no such document")

func scanModuleDoc(sc interface{ Scan(...any) error }) (ModuleDoc, error) {
	var d ModuleDoc
	var data string
	err := sc.Scan(&d.ID, &data, &d.CreatedAt, &d.UpdatedAt)
	d.Data = json.RawMessage(data)
	return d, err
}

// GetModuleDoc returns one document; ErrModuleDocNotFound when absent.
func GetModuleDoc(ctx context.Context, q Querier, module, collection, id string) (ModuleDoc, error) {
	d, err := scanModuleDoc(q.QueryRowContext(ctx, `SELECT doc_id, data, created_at, updated_at FROM module_docs
		WHERE module = ? AND collection = ? AND doc_id = ?`, module, collection, id))
	if errors.Is(err, sql.ErrNoRows) {
		return ModuleDoc{}, ErrModuleDocNotFound
	}
	return d, err
}

// ListModuleDocs returns a collection's documents by id, those after `after`
// (exclusive), at most limit.
func ListModuleDocs(ctx context.Context, q Querier, module, collection, after string, limit int) ([]ModuleDoc, error) {
	rows, err := q.QueryContext(ctx, `SELECT doc_id, data, created_at, updated_at FROM module_docs
		WHERE module = ? AND collection = ? AND doc_id > ? ORDER BY doc_id LIMIT ?`, module, collection, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ModuleDoc{}
	for rows.Next() {
		d, err := scanModuleDoc(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// SetModuleDoc writes a document whole, keeping when it was first made.
func SetModuleDoc(ctx context.Context, q Querier, module, collection, id string, data []byte, now int64) (ModuleDoc, error) {
	if _, err := q.ExecContext(ctx, `INSERT INTO module_docs (module, collection, doc_id, data, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (module, collection, doc_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
		module, collection, id, string(data), now, now); err != nil {
		return ModuleDoc{}, err
	}
	return GetModuleDoc(ctx, q, module, collection, id)
}

// UpdateModuleDoc merges fields into an existing document's top level; a
// field set to null is removed. ErrModuleDocNotFound when there is none.
// Run it in a transaction so a concurrent update is not lost.
func UpdateModuleDoc(ctx context.Context, q Querier, module, collection, id string, patch map[string]json.RawMessage, now int64) (ModuleDoc, error) {
	cur, err := GetModuleDoc(ctx, q, module, collection, id)
	if err != nil {
		return ModuleDoc{}, err
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(cur.Data, &fields); err != nil {
		return ModuleDoc{}, err
	}
	for k, v := range patch {
		if string(v) == "null" {
			delete(fields, k)
			continue
		}
		fields[k] = v
	}
	b, err := json.Marshal(fields)
	if err != nil {
		return ModuleDoc{}, err
	}
	return SetModuleDoc(ctx, q, module, collection, id, b, now)
}

// DeleteModuleDoc removes a document and reports whether there was one.
func DeleteModuleDoc(ctx context.Context, q Querier, module, collection, id string) (bool, error) {
	res, err := q.ExecContext(ctx, `DELETE FROM module_docs WHERE module = ? AND collection = ? AND doc_id = ?`, module, collection, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
