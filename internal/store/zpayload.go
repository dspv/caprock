package store

import (
	"bytes"
	"context"
	"database/sql/driver"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/klauspost/compress/zstd"
	"modernc.org/sqlite"
)

// Compressed tool payloads (ADR-093, 03-contracts.md § Compressed tool
// payloads).
//
// A tool call's payload and its result's are most of the database: 1.4 of
// the 1.6 GiB of payload on the owner's 2.5 GB file (2026-11-06). With the
// setting on, the daemon compresses those rows while idle, a window at a
// time; nothing is compressed on the write path, and every other kind —
// the prose above all — stays plain JSON.
//
// **The stored form is a JSONB string around a zstd frame.** One byte 0xEA
// (JSONB's TEXTRAW element, with a four-byte size), the frame's length as
// four big-endian bytes, then a standard zstd frame with no dictionary.
// SQLite's JSON functions read that BLOB as a well-formed JSONB string: a
// statement that does not know about compression gets NULL from
// json_extract, 0 from json_valid and nothing from json_each — never the
// "malformed JSON" error a bare zstd frame raises, which would fail a whole
// query because one row in its scan was compressed. Readers that want a tool
// row's fields read it through ZPayload, which decompresses; readers of the
// other kinds read it bare and cost exactly what they cost before.
//
// **No dictionary.** Measured on 20,000 of the owner's tool rows, a 64 KiB
// dictionary trained on that install's own rows gave 3.07× against 2.40×
// without one: about 130 MiB more on a 2.5 GB file, for a training step, a
// table of dictionaries every row must name, and one row whose loss makes
// every compressed payload unreadable. A dictionary shipped in the binary is
// ruled out by rule 4: it is made of its training data's strings.
const (
	// zEnvelope is the first byte: JSONB type 10 (TEXTRAW), size in the next
	// four bytes.
	zEnvelope = 0xEA
	// zHeaderLen is the envelope before the frame.
	zHeaderLen = 5
	// zMinSaving is the share a row must shrink by to be stored compressed:
	// a small row compresses to nearly its own size, and keeping it plain
	// keeps its reads free.
	zMinSavingPct = 10
	// zMaxPlain bounds what one decompression may produce, so a damaged
	// frame cannot ask for gigabytes.
	zMaxPlain = 64 << 20
)

// zMagic is a zstd frame's first four bytes.
var zMagic = [4]byte{0x28, 0xB5, 0x2F, 0xFD}

// ZPayload is events.payload as JSON text whether it is stored compressed or
// not. Every statement that may read a tool row's payload reads it through
// this (or ZPayloadOf), and TestEveryPayloadReadKnowsCompression fails on one
// that does not. A plain row never leaves SQLite: typeof() is answered from
// the record header, and only a BLOB reaches zjson.
const ZPayload = "(CASE WHEN typeof(payload) = 'blob' THEN zjson(payload) ELSE payload END)"

// ZPayloadE is ZPayload for a statement that names events "e".
const ZPayloadE = "(CASE WHEN typeof(e.payload) = 'blob' THEN zjson(e.payload) ELSE e.payload END)"

// zPayloadPr and zPayloadPo are ZPayload for ToolDrillStats' call and result.
const (
	zPayloadPr = "(CASE WHEN typeof(pr.payload) = 'blob' THEN zjson(pr.payload) ELSE pr.payload END)"
	zPayloadPo = "(CASE WHEN typeof(po.payload) = 'blob' THEN zjson(po.payload) ELSE po.payload END)"
)

// ZPayloadOf is ZPayload for a statement that names events alias.
func ZPayloadOf(alias string) string {
	c := alias + ".payload"
	return "(CASE WHEN typeof(" + c + ") = 'blob' THEN zjson(" + c + ") ELSE " + c + " END)"
}

var (
	zEncoder = sync.OnceValue(func() *zstd.Encoder {
		// EncodeAll is safe for concurrent use. One goroutine per call: the
		// idle job compresses rows one after another, and a step must not
		// take every core from the machine.
		e, err := zstd.NewWriter(nil,
			zstd.WithEncoderLevel(zstd.SpeedDefault),
			zstd.WithEncoderConcurrency(1),
			zstd.WithLowerEncoderMem(true))
		if err != nil {
			panic(err)
		}
		return e
	})
	zDecoder = sync.OnceValue(func() *zstd.Decoder {
		// Up to four decompressions at once, one per reading connection:
		// the pool has eight, and few read tool rows at the same moment.
		d, err := zstd.NewReader(nil,
			zstd.WithDecoderConcurrency(4),
			zstd.WithDecoderMaxMemory(zMaxPlain))
		if err != nil {
			panic(err)
		}
		return d
	})
)

// IsCompressedPayload reports whether b is a payload in the stored compressed
// form: the envelope, a length that matches, and a zstd frame.
func IsCompressedPayload(b []byte) bool {
	return len(b) >= zHeaderLen+len(zMagic) && b[0] == zEnvelope &&
		int(binary.BigEndian.Uint32(b[1:zHeaderLen])) == len(b)-zHeaderLen &&
		[4]byte(b[zHeaderLen:zHeaderLen+4]) == zMagic
}

// CompressPayload returns plain in the stored compressed form, and false when
// that would not save zMinSavingPct of it (the row then stays plain).
func CompressPayload(plain []byte) ([]byte, bool) {
	if len(plain) == 0 {
		return nil, false
	}
	out := make([]byte, zHeaderLen, zHeaderLen+len(plain)/2)
	out[0] = zEnvelope
	out = zEncoder().EncodeAll(plain, out)
	binary.BigEndian.PutUint32(out[1:zHeaderLen], uint32(len(out)-zHeaderLen))
	if len(out)*100 > len(plain)*(100-zMinSavingPct) {
		return nil, false
	}
	return out, true
}

// DecodePayload returns a stored payload as JSON: decompressed when it is in
// the compressed form, as it is otherwise.
func DecodePayload(b []byte) ([]byte, error) {
	if !IsCompressedPayload(b) {
		return b, nil
	}
	out, err := zDecoder().DecodeAll(b[zHeaderLen:], nil)
	if err != nil {
		return nil, fmt.Errorf("compressed payload: %w", err)
	}
	return out, nil
}

// PlainSize is the size a compressed payload had before it was compressed,
// read from the frame header without decompressing; ok is false for anything
// else. b may be just the first bytes of the stored value (zHeaderLen + 18
// covers every frame header).
func PlainSize(b []byte) (int64, bool) {
	if len(b) < zHeaderLen+len(zMagic) || b[0] != zEnvelope || [4]byte(b[zHeaderLen:zHeaderLen+4]) != zMagic {
		return 0, false
	}
	var h zstd.Header
	if err := h.Decode(b[zHeaderLen:]); err != nil || !h.HasFCS {
		return 0, false
	}
	return int64(h.FrameContentSize), true
}

// zCache keeps the last few decompressed payloads. A statement that reads
// several fields of one row calls zjson once per field with the same value;
// comparing a ~1 KB frame is far cheaper than decompressing it again.
type zCache struct {
	mu   sync.Mutex
	keys [4][]byte
	vals [4]string
	next int
}

var zjsonCache zCache

func (c *zCache) get(frame []byte) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := range c.keys {
		if c.keys[i] != nil && bytes.Equal(c.keys[i], frame) {
			return c.vals[i], true
		}
	}
	return "", false
}

func (c *zCache) put(frame []byte, v string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	// The slot's buffer is reused: a scan through thousands of rows makes
	// no garbage here.
	c.keys[c.next] = append(c.keys[c.next][:0], frame...)
	c.vals[c.next] = v
	c.next = (c.next + 1) % len(c.keys)
}

// zBuf is the decompression buffer zjson reuses; what it returns is a copy.
var zBuf = sync.Pool{New: func() any { b := make([]byte, 0, 16<<10); return &b }}

// zjson is the SQL function behind ZPayload: a compressed payload as JSON
// text, anything else unchanged. A frame that cannot be decompressed reads as
// an empty object, so one damaged row cannot fail every query that scans it;
// the row itself is left as it is.
func zjson(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
	switch v := args[0].(type) {
	case []byte:
		// VolatileArgs: v points into SQLite's memory and is valid only for
		// this call. The cache copies it; the return value is a new string.
		if !IsCompressedPayload(v) {
			return string(v), nil
		}
		if s, ok := zjsonCache.get(v); ok {
			return s, nil
		}
		bp := zBuf.Get().(*[]byte)
		out, err := zDecoder().DecodeAll(v[zHeaderLen:], (*bp)[:0])
		if err != nil {
			zBuf.Put(bp)
			return "{}", nil //nolint:nilerr // a damaged row reads as empty, see above
		}
		s := string(out)
		if cap(out) <= 1<<20 {
			*bp = out
			zBuf.Put(bp)
		}
		zjsonCache.put(v, s)
		return s, nil
	case string:
		return strings.Clone(v), nil
	default:
		return v, nil
	}
}

func init() {
	sqlite.MustRegisterFunction("zjson", &sqlite.FunctionImpl{
		NArgs:         1,
		Deterministic: true,
		VolatileArgs:  true,
		Scalar:        zjson,
	})
}

// The idle-time job (internal/daemon/compact.go) moves one cursor up and
// down the events table:
//
//   - **Up, while the setting is on.** CompressPayloadsStep examines the next
//     window of ids above the cursor and compresses each tool row in it older
//     than the cutoff; the cursor moves in the transaction that writes them.
//     It stops at the first row still too young, so new rows wait a day.
//   - **Down, while it is off.** DecompressPayloadsStep restores every
//     compressed row in the window below the cursor and lowers it.
//
// No compressed row has an id above the cursor. A row the job has passed may
// be plain — too small to be worth it, or rewritten since by a repair, which
// writes plain JSON — and is not looked at again.
const (
	// MetaPayloadZstdCursor is that cursor: an event id.
	MetaPayloadZstdCursor = "payload_zstd_cursor"
	// MetaPayloadZstdSaved is the payload bytes compression has saved so far,
	// added to by each compression step and taken from by each restoring one.
	// Rows deleted since are not taken off, so it is an upper bound — which
	// is what the free-disk check before restoring needs.
	MetaPayloadZstdSaved = "payload_zstd_saved"
	// MetaPayloadZstdRepacked is MetaPayloadZstdSaved when the daemon last
	// ran a VACUUM to repack what compression left (internal/daemon/zstd.go).
	MetaPayloadZstdRepacked = "payload_zstd_repacked"
)

// ZstdStep is what one step of the job did.
type ZstdStep struct {
	// Rows is how many payloads were compressed or restored; Bytes how many
	// payload bytes that saved or gave back.
	Rows  int
	Bytes int64
	// Cursor is the cursor after the step; Done is true when there is
	// nothing more to do in this direction for now.
	Cursor int64
	Done   bool
}

// zstdFuture is how far ahead of the clock a row's time may be and still
// count as young. A row stamped further ahead (a skewed clock) would hold the
// cursor for as long as its stamp is in the future; it is treated as old.
const zstdFuture = int64(60 * 60 * 1000)

func (s *Store) metaInt(ctx context.Context, key string) (int64, error) {
	v, err := s.GetMeta(ctx, key)
	if err != nil || v == "" {
		return 0, err
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("meta %s: %w", key, err)
	}
	return n, nil
}

// PayloadZstdCursor is the job's cursor; 0 means no row is compressed.
func (s *Store) PayloadZstdCursor(ctx context.Context) (int64, error) {
	return s.metaInt(ctx, MetaPayloadZstdCursor)
}

// PayloadZstdSaved is MetaPayloadZstdSaved.
func (s *Store) PayloadZstdSaved(ctx context.Context) (int64, error) {
	return s.metaInt(ctx, MetaPayloadZstdSaved)
}

// ToolFieldsFilled reports whether tool_fields holds every stored tool call.
// Compression waits for it: until then the Tools screen reads unfilled rows'
// fields from their payloads, through an index on the payload's JSON.
func (s *Store) ToolFieldsFilled(ctx context.Context) (bool, error) {
	n, err := s.metaInt(ctx, metaToolFieldsPending)
	return n == 0, err
}

type zChange struct {
	id       int64
	old, new any // string and []byte, one each way
	saved    int64
}

// CompressPayloadsStep compresses the tool payloads in the next window of up
// to `window` event ids above the cursor whose time is before cutoffMs. It is
// idempotent and resumable: the cursor moves in the transaction that writes
// the rows, and each update matches the payload it read, so a row rewritten
// meanwhile keeps what it now holds.
//
// The window is read outside the write transaction; the write lock is held
// for the updates alone.
func (s *Store) CompressPayloadsStep(ctx context.Context, window int, cutoffMs, nowMs int64) (ZstdStep, error) {
	if window <= 0 {
		window = 500
	}
	cur, err := s.PayloadZstdCursor(ctx)
	if err != nil {
		return ZstdStep{}, err
	}
	st := ZstdStep{Cursor: cur}
	// kind and ts come before payload in the record, and typeof() does not
	// read a value's overflow pages: only the candidates' payloads are read.
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, ts,
		       CASE WHEN kind IN ('tool.pre', 'tool.post') AND typeof(payload) = 'text' THEN payload END
		  FROM events WHERE id > ? ORDER BY id LIMIT ?`, cur, window)
	if err != nil {
		return st, err
	}
	var changes []zChange
	upto, seen, young := cur, 0, false
	for rows.Next() {
		var id, ts int64
		var payload []byte
		if err := rows.Scan(&id, &ts, &payload); err != nil {
			_ = rows.Close()
			return st, err
		}
		seen++
		if ts >= cutoffMs && ts <= nowMs+zstdFuture {
			young = true
			break
		}
		upto = id
		if payload == nil {
			continue
		}
		if z, ok := CompressPayload(payload); ok {
			changes = append(changes, zChange{id: id, old: string(payload), new: z, saved: int64(len(payload) - len(z))})
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return st, err
	}
	if err := rows.Close(); err != nil {
		return st, err
	}
	st.Done = young || seen < window
	if upto == cur {
		return st, nil
	}
	if err := s.applyZstd(ctx, changes, upto, &st); err != nil {
		return ZstdStep{Cursor: cur}, err
	}
	return st, nil
}

// DecompressPayloadsStep restores the compressed payloads in the window of up
// to `window` ids at and below the cursor, and lowers it past them. Done once
// the cursor is 0: no row is compressed.
func (s *Store) DecompressPayloadsStep(ctx context.Context, window int) (ZstdStep, error) {
	if window <= 0 {
		window = 500
	}
	cur, err := s.PayloadZstdCursor(ctx)
	if err != nil {
		return ZstdStep{}, err
	}
	st := ZstdStep{Cursor: cur}
	if cur <= 0 {
		st.Done = true
		return st, nil
	}
	lo := max(cur-int64(window), 0)
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, payload FROM events
		 WHERE id > ? AND id <= ? AND typeof(payload) = 'blob'`, lo, cur)
	if err != nil {
		return st, err
	}
	var changes []zChange
	for rows.Next() {
		var id int64
		var b []byte
		if err := rows.Scan(&id, &b); err != nil {
			_ = rows.Close()
			return st, err
		}
		if !IsCompressedPayload(b) {
			continue
		}
		plain, err := DecodePayload(b)
		if err != nil {
			// Left as it is: restoring it is impossible, and the reads
			// already treat it as an empty object.
			continue
		}
		changes = append(changes, zChange{id: id, old: b, new: string(plain), saved: -int64(len(plain) - len(b))})
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return st, err
	}
	if err := rows.Close(); err != nil {
		return st, err
	}
	st.Done = lo == 0
	if err := s.applyZstd(ctx, changes, lo, &st); err != nil {
		return ZstdStep{Cursor: cur}, err
	}
	return st, nil
}

// applyZstd writes one step's rows and its cursor in one transaction.
func (s *Store) applyZstd(ctx context.Context, changes []zChange, cursor int64, st *ZstdStep) error {
	return s.WithTx(ctx, func(q Querier) error {
		var delta int64
		for _, c := range changes {
			res, err := q.ExecContext(ctx, `UPDATE events SET payload = ? WHERE id = ? AND payload = ?`, c.new, c.id, c.old)
			if err != nil {
				return fmt.Errorf("event %d: %w", c.id, err)
			}
			if n, _ := res.RowsAffected(); n == 1 {
				st.Rows++
				delta += c.saved
			}
		}
		if delta < 0 {
			st.Bytes = -delta
		} else {
			st.Bytes = delta
		}
		if _, err := q.ExecContext(ctx, `
			INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
			MetaPayloadZstdCursor, strconv.FormatInt(cursor, 10)); err != nil {
			return err
		}
		// MAX(…, 0): rows deleted since they were compressed can make the
		// restored total pass the saved one.
		if _, err := q.ExecContext(ctx, `
			INSERT INTO meta(k, v) VALUES(?, MAX(?, 0)) ON CONFLICT(k)
			DO UPDATE SET v = MAX(CAST(v AS INTEGER) + ?, 0)`,
			MetaPayloadZstdSaved, delta, delta); err != nil {
			return err
		}
		st.Cursor = cursor
		return nil
	})
}
