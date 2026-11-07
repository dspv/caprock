package store

import (
	"context"
	"encoding/binary"
	"path/filepath"
	"strings"
	"testing"
)

// A leaf page's empty space is the gap between its cell pointers and its
// cell content, its freeblocks and its fragments; a page that is not a
// b-tree page is not counted.
func TestBtreeUnused(t *testing.T) {
	p := make([]byte, 4096)
	p[0] = 0x0D                                  // table leaf
	binary.BigEndian.PutUint16(p[3:5], 10)       // ten cells: pointers end at 8+20
	binary.BigEndian.PutUint16(p[5:7], 3000)     // content from 3000
	p[7] = 3                                     // fragmented bytes
	binary.BigEndian.PutUint16(p[1:3], 3100)     // first freeblock
	binary.BigEndian.PutUint16(p[3102:3104], 40) // its size, no next
	got, ok := btreeUnused(p)
	if want := int64(3000 - 28 + 3 + 40); !ok || got != want {
		t.Fatalf("unused %d %v, want %d", got, ok, want)
	}
	p[0] = 0x00 // an overflow or freelist trunk page
	if _, ok := btreeUnused(p); ok {
		t.Fatal("an overflow page counted as a b-tree page")
	}
	p[0] = 0x0D
	binary.BigEndian.PutUint16(p[5:7], 10) // content starting inside the pointers: not a b-tree page
	if _, ok := btreeUnused(p); ok {
		t.Fatal("a malformed page counted")
	}
}

func TestIsPtrmapPage(t *testing.T) {
	// 4096-byte pages: pointer-map pages at 2, 2+820, 2+2·820.
	for _, pg := range []int64{2, 822, 1642} {
		if !isPtrmapPage(pg, 4096) {
			t.Errorf("page %d is a pointer-map page", pg)
		}
	}
	for _, pg := range []int64{3, 821, 823} {
		if isPtrmapPage(pg, 4096) {
			t.Errorf("page %d is not", pg)
		}
	}
}

// Rows that shrank leave half-empty pages: the estimate finds them, and
// after a VACUUM it finds next to nothing.
func TestEstimatePack(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "c.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	db := st.DB()
	if _, err := db.Exec(`CREATE TABLE filler(id INTEGER PRIMARY KEY, b TEXT)`); err != nil {
		t.Fatal(err)
	}
	row := strings.Repeat("x", 900)
	for i := 0; i < 8000; i++ {
		if _, err := db.Exec(`INSERT INTO filler(b) VALUES(?)`, row); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`UPDATE filler SET b = 'y' WHERE id % 4 != 0`); err != nil {
		t.Fatal(err)
	}
	e, err := st.EstimatePack(ctx, 2000, 1)
	if err != nil {
		t.Fatal(err)
	}
	// About three quarters of ~7 MB of rows went: the estimate should see
	// megabytes, and never more than the file.
	if e.FreeBytesEst < 2<<20 || e.FreeBytesEst > e.Pages*e.PageSize {
		t.Fatalf("estimate %d of %d bytes: %+v", e.FreeBytesEst, e.Pages*e.PageSize, e)
	}
	if err := st.Pack(ctx); err != nil {
		t.Fatal(err)
	}
	after, err := st.EstimatePack(ctx, 2000, 1)
	if err != nil {
		t.Fatal(err)
	}
	if after.FreeBytesEst > e.FreeBytesEst/4 {
		t.Fatalf("after a VACUUM the estimate is still %d (was %d)", after.FreeBytesEst, e.FreeBytesEst)
	}
	// Pack leaves the pooled connection's automatic checkpoint as it was.
	var auto int
	for i := 0; i < 4; i++ {
		if err := db.QueryRow(`PRAGMA wal_autocheckpoint`).Scan(&auto); err != nil || auto == 0 {
			t.Fatalf("wal_autocheckpoint %d %v after Pack", auto, err)
		}
	}
}
