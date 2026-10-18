package obsidian

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// SyntheticVault writes n notes into dir: 50 folders, about 1.5 KB each,
// five [[links]] to other notes (one with a heading, one with display
// text), three #tags of 200, and frontmatter aliases on every fifth. The
// same seed writes the same vault.
func SyntheticVault(tb testing.TB, dir string, n int) {
	tb.Helper()
	r := rand.New(rand.NewPCG(1, 2))
	words := strings.Fields("graph note link memory session agent vault topic idea decision finding question sqlite index search token cost cache write read layout render daemon")
	for i := range n {
		var b strings.Builder
		if i%5 == 0 {
			fmt.Fprintf(&b, "---\naliases: [Alias %d]\ntags: [kind/%d]\n---\n", i, i%7)
		}
		fmt.Fprintf(&b, "# Note %d\n\n", i)
		for p := range 3 {
			for range 60 {
				b.WriteString(words[r.IntN(len(words))])
				b.WriteByte(' ')
			}
			switch p {
			case 0:
				fmt.Fprintf(&b, "[[Note %d]] [[Note %d#Part]] #t%d\n\n", r.IntN(n), r.IntN(n), r.IntN(200))
			case 1:
				fmt.Fprintf(&b, "[[Note %d|that one]] [[Alias %d]] #t%d\n\n", r.IntN(n), r.IntN(n/5)*5, r.IntN(200))
			default:
				fmt.Fprintf(&b, "[[Note %d]] #t%d\n", r.IntN(n), r.IntN(200))
			}
		}
		p := filepath.Join(dir, fmt.Sprintf("folder%02d", i%50), fmt.Sprintf("Note %d.md", i))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			tb.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(b.String()), 0o644); err != nil {
			tb.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(dir, ".obsidian"), 0o755); err != nil {
		tb.Fatal(err)
	}
}

// TestMeasureFiveThousandNotes measures an import of a 5,000-note vault into
// an on-disk database, an idle refresh and a refresh after one edit, with
// the heap the import allocated. Run with CAPROCK_OBSIDIAN_MEASURE=1 (it
// takes seconds); the figures in ADR-078 come from it.
func TestMeasureFiveThousandNotes(t *testing.T) {
	if os.Getenv("CAPROCK_OBSIDIAN_MEASURE") == "" {
		t.Skip("set CAPROCK_OBSIDIAN_MEASURE=1 to measure")
	}
	ctx := context.Background()
	dir := t.TempDir()
	vault := filepath.Join(dir, "vault")
	SyntheticVault(t, vault, 5000)
	st, err := store.Open(ctx, filepath.Join(dir, "caprock.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	svc := &Service{Store: st}

	runtime.GC()
	var m0, m1 runtime.MemStats
	runtime.ReadMemStats(&m0)
	t0 := time.Now()
	v, r, err := svc.Add(ctx, vault, false)
	if err != nil {
		t.Fatal(err)
	}
	importDur := time.Since(t0)
	runtime.ReadMemStats(&m1)
	t.Logf("import: %d notes, %d links, %d merged, %v; allocated %.1f MB, heap in use after %.1f MB",
		r.Notes, r.Links, r.Merged, importDur.Round(time.Millisecond), float64(m1.TotalAlloc-m0.TotalAlloc)/(1<<20), float64(m1.HeapInuse)/(1<<20))

	t0 = time.Now()
	_, r, err = svc.Refresh(ctx, v.ID, false)
	if err != nil || r.Read != 0 {
		t.Fatalf("idle refresh: %+v %v", r, err)
	}
	t.Logf("idle refresh (walk and stat only): %v", time.Since(t0).Round(time.Millisecond))

	p := filepath.Join(vault, "folder07", "Note 7.md")
	if err := os.WriteFile(p, []byte("Rewritten. [[Note 8]] #fresh"), 0o644); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Minute)
	_ = os.Chtimes(p, later, later)
	t0 = time.Now()
	_, r, err = svc.Refresh(ctx, v.ID, false)
	if err != nil || r.Read != 1 {
		t.Fatalf("one-edit refresh: %+v %v", r, err)
	}
	t.Logf("refresh after one edit: %v", time.Since(t0).Round(time.Millisecond))

	t0 = time.Now()
	if err := svc.Remove(ctx, v.ID); err != nil {
		t.Fatal(err)
	}
	t.Logf("remove: %v", time.Since(t0).Round(time.Millisecond))
	var left int
	_ = st.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM brain_nodes`).Scan(&left)
	if left != 0 {
		t.Fatalf("%d nodes left after remove", left)
	}
	g, err := store.ReadBrainGraph(ctx, st.DB(), store.BrainFilter{})
	if err != nil || len(g.Nodes) != 0 {
		t.Fatalf("graph after remove: %d %v", len(g.Nodes), err)
	}
}
