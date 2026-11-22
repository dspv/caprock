package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
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

// moduleGens is a generation per (module, collection), moved by every write
// this process makes to it (SetModuleDoc, UpdateModuleDoc through it,
// DeleteModuleDoc, and TouchModuleDocs once a transaction commits). A list
// read at one generation is the same list while the generation holds, so the
// list endpoint answers a client that already has it with a 304 and no read
// (§ Private modules in 03-contracts.md). The Ops module pages through its
// collections every few seconds, and one collection was ~18 MB read again
// each time (2026-11-22).
//
// Only this process writes module_docs, so a counter in memory sees every
// write. boot is drawn at random when the process starts: a counter that
// starts again at zero after a restart is never mistaken for one an older
// process handed out.
var moduleGens = struct {
	sync.Mutex
	boot uint64
	m    map[[2]string]uint64
}{boot: randomBoot(), m: map[[2]string]uint64{}}

func randomBoot() uint64 {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return binary.LittleEndian.Uint64(b[:])
}

// reseedModuleGens is a restart, for tests: a new boot value and every
// generation back at zero.
func reseedModuleGens() {
	moduleGens.Lock()
	moduleGens.boot, moduleGens.m = randomBoot(), map[[2]string]uint64{}
	moduleGens.Unlock()
}

// TouchModuleDocs moves a collection's generation. The writes here do it
// themselves; a caller that writes inside a transaction calls it again once
// the transaction commits, so a list read between the write and the commit
// (the old rows, at the new generation) is not taken for the current one.
func TouchModuleDocs(module, collection string) {
	moduleGens.Lock()
	moduleGens.m[[2]string{module, collection}]++
	moduleGens.Unlock()
}

// ModuleDocsVersion names a collection's contents as this process last
// wrote them: an equal version, an equal collection. Read it before reading
// the collection, so a write landing during the read moves it past what was
// read rather than under it.
func ModuleDocsVersion(module, collection string) string {
	moduleGens.Lock()
	defer moduleGens.Unlock()
	return strconv.FormatUint(moduleGens.boot, 36) + "." + strconv.FormatUint(moduleGens.m[[2]string{module, collection}], 36)
}

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
	TouchModuleDocs(module, collection)
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
	TouchModuleDocs(module, collection)
	n, err := res.RowsAffected()
	return n > 0, err
}
