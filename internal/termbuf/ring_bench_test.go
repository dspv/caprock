package termbuf

import (
	"bytes"
	"fmt"
	"testing"
)

// BenchmarkRingWrite is the resource audit's terminal-buffer probe
// (2026-10-18): one chunk at a time into a 256 KiB ring already full, mode
// scanning on as in the real write path.
//
// "idle" has nobody waiting on Changed: a session with no tab attached.
// "watched" takes Changed before every write, as a connected terminal does
// once it has caught up, so every wake has a channel to close and replace.
func BenchmarkRingWrite(b *testing.B) {
	for _, size := range []int{1 << 10, 16 << 10} {
		p := bytes.Repeat([]byte("x"), size)
		for _, watched := range []bool{false, true} {
			name := fmt.Sprintf("chunk=%d/idle", size)
			if watched {
				name = fmt.Sprintf("chunk=%d/watched", size)
			}
			b.Run(name, func(b *testing.B) {
				r := NewRing(256 << 10)
				r.Write(bytes.Repeat([]byte("x"), 256<<10))
				b.SetBytes(int64(size))
				b.ReportAllocs()
				b.ResetTimer()
				for range b.N {
					if watched {
						_ = r.Changed()
					}
					r.Write(p)
				}
			})
		}
	}
}
