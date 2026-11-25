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
// DeleteModuleDoc, and TouchModuleDoc once a transaction commits). A list
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
//
// Each collection also keeps which document its newest writes touched
// (moduleWritesKept of them), so a page of its list can tell whether a write
// since it was read could have changed it (ModuleDocsPageCurrent): a write to
// one document leaves every page that does not cover it as it was.
var moduleGens = struct {
	sync.Mutex
	boot uint64
	m    map[[2]string]*moduleGen
}{boot: randomBoot(), m: map[[2]string]*moduleGen{}}

// moduleGen is one collection's generation and its newest writes.
type moduleGen struct {
	gen uint64
	// writes are the newest writes, oldest first: writes[i] moved the
	// generation to gen-len(writes)+1+i. A write of the whole collection
	// (TouchModuleDocs) is an empty id.
	writes []string
}

// moduleWritesKept is how many of a collection's newest writes are kept by
// document. A page read further back than that is read again. The owner's
// busiest collection took about 2,000 writes an hour (2026-11-25), so 512 is
// a quarter of an hour of them, and a page is asked for every few seconds.
const moduleWritesKept = 512

func randomBoot() uint64 {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return binary.LittleEndian.Uint64(b[:])
}

// reseedModuleGens is a restart, for tests: a new boot value and every
// generation back at zero.
func reseedModuleGens() {
	moduleGens.Lock()
	moduleGens.boot, moduleGens.m = randomBoot(), map[[2]string]*moduleGen{}
	moduleGens.Unlock()
}

// touchModuleGen moves a collection's generation for a write of doc ("" for
// the whole collection). Called with moduleGens held.
func touchModuleGen(module, collection, doc string) {
	k := [2]string{module, collection}
	g := moduleGens.m[k]
	if g == nil {
		g = &moduleGen{}
		moduleGens.m[k] = g
	}
	g.gen++
	if len(g.writes) == moduleWritesKept {
		copy(g.writes, g.writes[1:])
		g.writes = g.writes[:moduleWritesKept-1]
	}
	g.writes = append(g.writes, doc)
}

// TouchModuleDocs moves a collection's generation as a write of any of its
// documents would: every page of its list is read again.
func TouchModuleDocs(module, collection string) {
	moduleGens.Lock()
	touchModuleGen(module, collection, "")
	moduleGens.Unlock()
}

// TouchModuleDoc moves a collection's generation for a write of one
// document. The writes here do it themselves; a caller that writes inside a
// transaction calls it again once the transaction commits, so a list read
// between the write and the commit (the old rows, at the new generation) is
// not taken for the current one.
func TouchModuleDoc(module, collection, doc string) {
	moduleGens.Lock()
	touchModuleGen(module, collection, doc)
	moduleGens.Unlock()
}

// ModuleDocsMark is a collection's generation at a moment of this process.
type ModuleDocsMark struct {
	Boot, Gen uint64
}

// String names the mark: boot and generation in base 36.
func (m ModuleDocsMark) String() string {
	return strconv.FormatUint(m.Boot, 36) + "." + strconv.FormatUint(m.Gen, 36)
}

// ModuleDocsMarkNow is a collection's mark now. Read it before reading the
// collection, so a write landing during the read moves it past what was read
// rather than under it.
func ModuleDocsMarkNow(module, collection string) ModuleDocsMark {
	moduleGens.Lock()
	defer moduleGens.Unlock()
	m := ModuleDocsMark{Boot: moduleGens.boot}
	if g := moduleGens.m[[2]string{module, collection}]; g != nil {
		m.Gen = g.gen
	}
	return m
}

// ModuleDocsVersion names a collection's contents as this process last
// wrote them: an equal version, an equal collection.
func ModuleDocsVersion(module, collection string) string {
	return ModuleDocsMarkNow(module, collection).String()
}

// ModuleDocsPageCurrent reports whether a page of a collection's list read at
// mark is still what a read now would give: no write since touched a document
// the page covers. A page is the documents after `after`, by id, up to its
// last, last; a page that was not full (fewer than its limit) covers every id
// after `after`, since a new document there would join it. A write of a
// document past a full page's last changes nothing on it: the page still
// holds the same first documents after `after`. A mark from another start,
// or further back than the writes kept, is never current.
func ModuleDocsPageCurrent(module, collection string, mark ModuleDocsMark, after, last string, full bool) bool {
	moduleGens.Lock()
	defer moduleGens.Unlock()
	if mark.Boot != moduleGens.boot {
		return false
	}
	g := moduleGens.m[[2]string{module, collection}]
	if g == nil {
		return mark.Gen == 0
	}
	if mark.Gen > g.gen {
		return false
	}
	since := g.gen - mark.Gen
	if since > uint64(len(g.writes)) {
		return false
	}
	for _, doc := range g.writes[uint64(len(g.writes))-since:] {
		if doc == "" || (doc > after && (!full || doc <= last)) {
			return false
		}
	}
	return true
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
	TouchModuleDoc(module, collection, id)
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
	TouchModuleDoc(module, collection, id)
	n, err := res.RowsAffected()
	return n > 0, err
}
