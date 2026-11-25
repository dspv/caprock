package store

import (
	"bytes"
	"context"
	"encoding/gob"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"
)

// Kept parts across restarts (migration 0093, § Kept parts DDL in
// 03-contracts.md).
//
// WHY. A range's parts (PartsCache) lived in memory only, so every start read
// all of history again to rebuild them: Warm builds 7d, 30d and all time, and
// scanEventParts over the stand's 1.18M rows took 6.8 s, read alongside every
// other start-up job; the first /v1/history?range=7d after a start took
// 2.9–4.4 s (2026-11-24 audit).
//
// WHAT. A range's parts are written to parts_kept with the EventsMark they
// were read at, after each full read and at most every partsSaveEvery after
// that. A cache that has not read a range yet starts from the row and reads
// only what moved since its mark, exactly as it does between two asks in one
// run (keptParts.refresh): the mark is the database's own (newest event id,
// the moved counter, session_gen), so it holds across a restart. A row is
// used only when it was written by this same build (the daemon's version and
// keptPartsFormat) and is younger than partsRebuild, the age at which a kept
// range is read whole anyway; anything else is a full read, as before.
// TestKeptPartsEqualAFreshRead holds a range started from its row and brought
// up to date to the range read afresh.

// keptPartsFormat is the encoding below. Bump it when sessionPart or any part
// type changes shape or meaning; a row of another format is ignored.
const keptPartsFormat = 1

// partsSaveEvery bounds how often a range's parts are written again after
// partial reads: a restart then reads at most this long of moves.
const partsSaveEvery = 10 * time.Minute

// The gob mirror of the parts: exported fields, the same values.
type (
	gobKind struct {
		Kind                 string
		N, Tin, Tout, Cr, Cw int64
		Cost, Paid           float64
	}
	gobModel struct {
		Model                 string
		Tokens                int64
		Cost                  float64
		Turns, Out, CacheRead int64
	}
	gobCount struct {
		Model         string
		Turns, Tokens int64
	}
	gobHour struct {
		Bucket, Hr                   int64
		Tokens, Input, Turns, Priced int64
		Cost                         float64
	}
	gobAttr struct {
		Dir     string
		HasDir  bool
		Work    WorkKind
		HasWork bool
		Tokens  int64
		Cost    float64
		Turns   int64
	}
	gobTool struct {
		Tool         string
		Calls, Bytes int64
	}
	gobUsage struct {
		Model    string
		Sub      bool
		Records  int64
		Requests int64
		CostUSD  float64
	}
	gobHermes struct {
		Basis, Source   string
		Background      int
		Turns, Unpriced int64
		USD             float64
	}
	gobCursor struct {
		Model            string
		USD              float64
		Requests, Tokens int64
		HasCost          bool
	}
	gobPart struct {
		Kinds      []gobKind
		Models     []gobModel
		Unpriced   []gobCount
		Background []gobCount
		Hours      []gobHour
		Attr       []gobAttr
		Unlinked   int64
		Tools      []gobTool
		Usage      []gobUsage
		Hermes     []gobHermes
		Cursor     []gobCursor
	}
	gobKept struct {
		Base, Width int64
		Sids        map[int64]gobPart
		MaxID       int64
		Moved       int64
		Gens        map[string]int64
	}
)

func toGobPart(p *sessionPart) gobPart {
	g := gobPart{Unlinked: p.unlinked}
	for _, k := range p.kinds {
		g.Kinds = append(g.Kinds, gobKind{k.kind, k.n, k.tin, k.tout, k.cr, k.cw, k.cost, k.paid})
	}
	for _, m := range p.models {
		g.Models = append(g.Models, gobModel{m.model, m.tokens, m.cost, m.turns, m.out, m.cacheRead})
	}
	for _, c := range p.unpriced {
		g.Unpriced = append(g.Unpriced, gobCount{c.model, c.turns, c.tokens})
	}
	for _, c := range p.background {
		g.Background = append(g.Background, gobCount{c.model, c.turns, c.tokens})
	}
	for _, h := range p.hours {
		g.Hours = append(g.Hours, gobHour{h.bucket, h.hr, h.tokens, h.input, h.turns, h.priced, h.cost})
	}
	for _, a := range p.attr {
		g.Attr = append(g.Attr, gobAttr{a.dir, a.hasDir, a.work, a.hasWork, a.tokens, a.cost, a.turns})
	}
	for _, t := range p.tools {
		g.Tools = append(g.Tools, gobTool{t.tool, t.calls, t.bytes})
	}
	for _, u := range p.usage {
		g.Usage = append(g.Usage, gobUsage{u.model, u.sub, u.c.Records, u.c.Requests, u.c.CostUSD})
	}
	for _, h := range p.hermes {
		g.Hermes = append(g.Hermes, gobHermes{h.basis, h.source, h.background, h.turns, h.unpriced, h.usd})
	}
	for _, c := range p.cursor {
		g.Cursor = append(g.Cursor, gobCursor{c.model, c.usd, c.requests, c.tokens, c.hasCost})
	}
	return g
}

// fromGobPart is a stored part as kept in memory, its names through names
// (interner): gob makes a string per occurrence, as the driver does per row.
func fromGobPart(g gobPart, names interner) *sessionPart {
	p := &sessionPart{unlinked: g.Unlinked}
	for _, k := range g.Kinds {
		p.kinds = append(p.kinds, kindPart{names.of(k.Kind), k.N, k.Tin, k.Tout, k.Cr, k.Cw, k.Cost, k.Paid})
	}
	for _, m := range g.Models {
		p.models = append(p.models, modelPart{names.of(m.Model), m.Tokens, m.Cost, m.Turns, m.Out, m.CacheRead})
	}
	for _, c := range g.Unpriced {
		p.unpriced = append(p.unpriced, countPart{names.of(c.Model), c.Turns, c.Tokens})
	}
	for _, c := range g.Background {
		p.background = append(p.background, countPart{names.of(c.Model), c.Turns, c.Tokens})
	}
	for _, h := range g.Hours {
		p.hours = append(p.hours, hourPart{h.Bucket, h.Hr, h.Tokens, h.Input, h.Turns, h.Priced, h.Cost})
	}
	for _, a := range g.Attr {
		p.attr = append(p.attr, attrPart{names.of(a.Dir), a.HasDir, a.Work, a.HasWork, a.Tokens, a.Cost, a.Turns})
	}
	for _, t := range g.Tools {
		p.tools = append(p.tools, toolPart{names.of(t.Tool), t.Calls, t.Bytes})
	}
	for _, u := range g.Usage {
		p.usage = append(p.usage, usagePart{names.of(u.Model), u.Sub, usageCount{Records: u.Records, Requests: u.Requests, CostUSD: u.CostUSD}})
	}
	for _, h := range g.Hermes {
		p.hermes = append(p.hermes, hermesPart{h.Basis, h.Source, h.Background, h.Turns, h.Unpriced, h.USD})
	}
	for _, c := range g.Cursor {
		p.cursor = append(p.cursor, cursorPart{c.Model, c.USD, c.Requests, c.Tokens, c.HasCost})
	}
	return p
}

// encodeKept is a range's parts and mark as stored: gob, zstd-compressed.
func encodeKept(rp rangeParts, mark EventsMark) ([]byte, error) {
	g := gobKept{Base: rp.base, Width: rp.width, Sids: make(map[int64]gobPart, len(rp.sids)),
		MaxID: mark.maxID, Moved: mark.moved, Gens: mark.gens}
	for sid, p := range rp.sids {
		g.Sids[sid] = toGobPart(p)
	}
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(g); err != nil {
		return nil, err
	}
	// An encoder of its own, dropped after: an encoder keeps the history
	// buffer of the largest input it compressed for as long as it lives, and
	// a range's parts are megabytes where a payload is kilobytes. Through the
	// shared payload encoder (zEncoder) that was 8 MB of Go heap held for the
	// life of the daemon on a copy of the owner's database (2026-11-25). The
	// same level, so the same frames.
	enc, err := zstd.NewWriter(nil,
		zstd.WithEncoderLevel(zstd.SpeedDefault),
		zstd.WithEncoderConcurrency(1),
		zstd.WithLowerEncoderMem(true))
	if err != nil {
		return nil, err
	}
	defer func() { _ = enc.Close() }()
	return enc.EncodeAll(buf.Bytes(), nil), nil
}

// keptDecoder reads the stored parts, which can be larger than any payload.
var keptDecoder = sync.OnceValue(func() *zstd.Decoder {
	d, err := zstd.NewReader(nil, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(512<<20))
	if err != nil {
		panic(err)
	}
	return d
})

func decodeKept(b []byte) (rangeParts, EventsMark, error) {
	plain, err := keptDecoder().DecodeAll(b, nil)
	if err != nil {
		return rangeParts{}, EventsMark{}, err
	}
	var g gobKept
	if err := gob.NewDecoder(bytes.NewReader(plain)).Decode(&g); err != nil {
		return rangeParts{}, EventsMark{}, err
	}
	rp := rangeParts{sids: make(map[int64]*sessionPart, len(g.Sids)), base: g.Base, width: g.Width}
	names := interner{}
	for sid, p := range g.Sids {
		rp.sids[sid] = fromGobPart(p, names)
	}
	gens := g.Gens
	if gens == nil {
		gens = map[string]int64{}
	}
	return rp, EventsMark{maxID: g.MaxID, moved: g.Moved, gens: gens}, nil
}

// loadKept reads a range's stored parts, when this build wrote them and they
// are younger than partsRebuild.
func loadKept(ctx context.Context, q Querier, from int64, version string, now time.Time) (rangeParts, EventsMark, time.Time, bool) {
	var built int64
	var ver string
	var format int
	var blob []byte
	err := q.QueryRowContext(ctx, `SELECT built_at, version, format, parts FROM parts_kept WHERE range_from = ?`, from).
		Scan(&built, &ver, &format, &blob)
	if err != nil || ver != version || format != keptPartsFormat {
		return rangeParts{}, EventsMark{}, time.Time{}, false
	}
	at := time.UnixMilli(built)
	if now.Sub(at) >= partsRebuild || at.After(now) {
		return rangeParts{}, EventsMark{}, time.Time{}, false
	}
	rp, mark, err := decodeKept(blob)
	if err != nil || rp.width != 3600000 || rp.base != from {
		return rangeParts{}, EventsMark{}, time.Time{}, false
	}
	return rp, mark, at, true
}

// saveKept writes a range's parts, and drops rows too old to be used.
func saveKept(ctx context.Context, q Querier, from int64, version string, built time.Time, blob []byte) error {
	if _, err := q.ExecContext(ctx, `INSERT INTO parts_kept (range_from, built_at, version, format, parts) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(range_from) DO UPDATE SET built_at = excluded.built_at, version = excluded.version,
		  format = excluded.format, parts = excluded.parts`, from, built.UnixMilli(), version, keptPartsFormat, blob); err != nil {
		return err
	}
	_, err := q.ExecContext(ctx, `DELETE FROM parts_kept WHERE built_at < ?`, built.Add(-partsRebuild).UnixMilli())
	return err
}
