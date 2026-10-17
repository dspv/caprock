package ingest

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// BenchmarkReadFileOversize is the resource audit's oversized-record probe
// (docs/resource-usage-audit-2026-10-18.md, F1) kept as a benchmark: one read of
// a transcript holding a single record larger than MaxLine, written whole
// (with its newline) or still being written (without). Every iteration starts
// from a fresh file state, so nothing persisted lets a pass skip the work. Two
// sizes show whether the memory a read takes grows with the record.
//
//	go test ./internal/ingest -run x -bench ReadFileOversize -benchmem -count=5
func BenchmarkReadFileOversize(b *testing.B) {
	st, err := store.Open(context.Background(), ":memory:", quiet())
	if err != nil {
		b.Fatal(err)
	}
	defer st.Close()
	for _, mib := range []int{32, 64} {
		for _, complete := range []bool{false, true} {
			name := strconv.Itoa(mib) + "MiB/partial"
			if complete {
				name = strconv.Itoa(mib) + "MiB/complete"
			}
			b.Run(name, func(b *testing.B) {
				data := bytes.Repeat([]byte("x"), mib<<20)
				if complete {
					data = append(data, '\n')
				}
				benchReadFile(b, st, data)
			})
		}
	}
}

// BenchmarkReadFileSmallRecords reads 4,096 short records (rejected by the
// parser, so the store is not what is timed): the ordinary case, which bounded
// reading must not make worse.
func BenchmarkReadFileSmallRecords(b *testing.B) {
	st, err := store.Open(context.Background(), ":memory:", quiet())
	if err != nil {
		b.Fatal(err)
	}
	defer st.Close()
	line := append(bytes.Repeat([]byte("x"), 1023), '\n')
	benchReadFile(b, st, bytes.Repeat(line, 4096))
}

func benchReadFile(b *testing.B, st *store.Store, data []byte) {
	b.Helper()
	p := filepath.Join(b.TempDir(), "bench.jsonl")
	if err := os.WriteFile(p, data, 0o600); err != nil {
		b.Fatal(err)
	}
	fi, err := os.Stat(p)
	if err != nil {
		b.Fatal(err)
	}
	tl := New(filepath.Dir(p), nil, st, quiet())
	ctx := context.Background()
	b.SetBytes(int64(len(data)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		tl.readFile(ctx, &fileState{path: p, lastSize: -1}, fi)
	}
}
