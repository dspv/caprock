package store

import (
	"context"
	"encoding/binary"
	"fmt"
	"math/rand/v2"
)

// What packing the database would give back, estimated from a sample of its
// pages (internal/daemon/pack.go shows it before the user starts one).
//
// A VACUUM rebuilds every table and index into fresh pages. It returns the
// freelist, and the empty space inside the b-tree pages — the leaf pages
// rows left half empty when they shrank or went. It does not touch overflow
// pages, the chains a large payload spills into, and it does not fill a
// rebuilt page to the last byte either: a cell never splits across pages.
//
// So the estimate reads `sample` pages picked at random through the
// sqlite_dbpage table — a few thousand page reads, not the whole file that
// dbstat walks (28 s on the owner's 2.1 GB copy, 2026-11-07) — and, for each
// b-tree page, adds up the bytes no cell uses: the gap between the cell
// pointers and the cell content, the freeblocks and the fragments. Scaled to
// the file, that is the empty space a rebuild could pack; the rebuild leaves
// packResidual of each new b-tree page empty again.
const (
	// packResidual is the share of a b-tree page a VACUUM leaves unused.
	// Measured with dbstat on two copies of the owner's database after a
	// VACUUM (2026-11-07): 12% (153 MiB of 1,250 MiB of b-tree pages) on one
	// whose tool output was compressed, 15% (227 MiB of 1,515 MiB) on one
	// that was not. The larger is used, so the estimate errs low: with it
	// the model gave 398 MiB where the VACUUM freed 442, and 118 MiB where
	// it freed 118.
	packResidual = 0.15
	// PackSample is how many pages EstimatePack reads by default.
	PackSample = 4000
)

// PackEstimate is the database file and what a VACUUM of it would free.
type PackEstimate struct {
	PageSize  int64
	Pages     int64
	FreePages int64
	// Sampled pages were read; BtreePages of them were b-tree pages, with
	// UnusedBytes of empty space between them.
	Sampled     int
	BtreePages  int
	UnusedBytes int64
	// FreeBytesEst is what a VACUUM would give back to the disk: the
	// freelist, and the empty b-tree space beyond what the rebuild leaves.
	// An estimate, and named as one wherever it is shown.
	FreeBytesEst int64
}

// UsedBytes is the file less its freelist: what a VACUUM copies.
func (p PackEstimate) UsedBytes() int64 { return (p.Pages - p.FreePages) * p.PageSize }

// EstimatePack reads `sample` random pages (seeded, so two calls on an
// unchanged file agree) and estimates what a VACUUM would free.
func (s *Store) EstimatePack(ctx context.Context, sample int, seed uint64) (PackEstimate, error) {
	pc, err := s.Pages(ctx)
	if err != nil {
		return PackEstimate{}, err
	}
	mode, err := s.AutoVacuum(ctx)
	if err != nil {
		return PackEstimate{}, err
	}
	e := PackEstimate{PageSize: pc.PageSize, Pages: pc.Pages, FreePages: pc.Free}
	if pc.Pages < 2 || pc.PageSize <= 0 {
		e.FreeBytesEst = pc.FreeBytes()
		return e, nil
	}
	if sample <= 0 {
		sample = PackSample
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return e, err
	}
	defer conn.Close()
	stmt, err := conn.PrepareContext(ctx, `SELECT data FROM sqlite_dbpage WHERE pgno = ?`)
	if err != nil {
		return e, fmt.Errorf("sqlite_dbpage: %w", err)
	}
	defer stmt.Close()
	rnd := rand.New(rand.NewPCG(seed, seed^0x9E3779B97F4A7C15))
	for range sample {
		// Page 1 holds the file header in its first 100 bytes; it is one
		// page of thousands and is left out.
		pgno := 2 + rnd.Int64N(pc.Pages-1)
		if mode != 0 && isPtrmapPage(pgno, pc.PageSize) {
			e.Sampled++
			continue
		}
		var data []byte
		if err := stmt.QueryRowContext(ctx, pgno).Scan(&data); err != nil {
			return e, fmt.Errorf("page %d: %w", pgno, err)
		}
		e.Sampled++
		if unused, ok := btreeUnused(data); ok {
			e.BtreePages++
			e.UnusedBytes += unused
		}
	}
	e.FreeBytesEst = e.freeEst()
	return e, nil
}

// freeEst is FreeBytesEst from the sample.
func (e PackEstimate) freeEst() int64 {
	free := e.FreePages * e.PageSize
	if e.Sampled == 0 {
		return free
	}
	scale := float64(e.Pages) / float64(e.Sampled)
	btree := float64(e.BtreePages) * float64(e.PageSize) * scale
	unused := float64(e.UnusedBytes) * scale
	packable := unused - packResidual/(1-packResidual)*(btree-unused)
	return free + int64(max(packable, 0))
}

// isPtrmapPage reports whether pgno is one of the pointer-map pages an
// auto-vacuum database keeps; their first byte is an entry type, which can
// read like a b-tree page's flag.
func isPtrmapPage(pgno, pageSize int64) bool {
	per := pageSize/5 + 1
	return pgno >= 2 && (pgno-2)%per == 0
}

// btreeUnused is the empty space in one b-tree page, and whether the page
// is a b-tree page at all.
func btreeUnused(d []byte) (int64, bool) {
	if len(d) < 12 {
		return 0, false
	}
	var hdr int
	switch d[0] {
	case 0x0D, 0x0A: // table leaf, index leaf
		hdr = 8
	case 0x05, 0x02: // table interior, index interior
		hdr = 12
	default:
		return 0, false
	}
	n := len(d)
	cells := int(binary.BigEndian.Uint16(d[3:5]))
	start := int(binary.BigEndian.Uint16(d[5:7]))
	if start == 0 {
		start = 65536
	}
	gap := start - (hdr + 2*cells)
	if gap < 0 || start > n {
		// Not a well-formed b-tree page: a freelist page holding old bytes.
		return 0, false
	}
	unused := gap + int(d[7])
	fb := int(binary.BigEndian.Uint16(d[1:3]))
	for i := 0; fb != 0 && i < n/4; i++ {
		if fb+4 > n {
			return 0, false
		}
		unused += int(binary.BigEndian.Uint16(d[fb+2 : fb+4]))
		next := int(binary.BigEndian.Uint16(d[fb : fb+2]))
		if next != 0 && next <= fb {
			return 0, false
		}
		fb = next
	}
	return int64(min(unused, n)), true
}
