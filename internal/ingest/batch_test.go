package ingest

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// A read stopped part-way through a batch — the daemon shutting down —
// commits the lines it finished with the offset they reach, and the next read
// stores the rest: every turn once, the offset in the database never ahead of
// the events, and the counters matching the rows.
func TestAReadStoppedMidBatchResumesWithoutLossOrDuplicates(t *testing.T) {
	tl, path := oversizeTailer(t)
	st := tl.Store
	const lines = 40
	appendTo(t, path, lineBlock(lines))

	ctx, cancel := context.WithCancel(context.Background())
	writes := 0
	tl.Recorder.OnWrite = func() {
		writes++
		if writes == 17 {
			cancel()
		}
	}
	tl.pass(ctx, false)
	tl.Recorder.OnWrite = nil

	stored := turnsStored(t, st)
	if stored == 0 || stored >= lines {
		t.Fatalf("stored %d turns before the stop, want part of %d", stored, lines)
	}
	saved, err := store.GetOffset(context.Background(), st.DB(), path)
	if err != nil {
		t.Fatal(err)
	}
	if want := int64(len(lineBlock(stored))); saved != want {
		t.Fatalf("saved offset %d after %d stored turns, want %d: the offset and the events disagree", saved, stored, want)
	}
	if off, _ := state(tl, path); off != saved {
		t.Fatalf("in-memory offset %d, saved %d", off, saved)
	}
	if n := tl.Stats().EventsStored; n != int64(stored) {
		t.Fatalf("counted %d stored events, the database holds %d", n, stored)
	}

	tl.pass(context.Background(), false)
	if n := turnsStored(t, st); n != lines {
		t.Fatalf("stored %d turns after resuming, want %d", n, lines)
	}
	var turns int
	if err := st.DB().QueryRow(`SELECT turns FROM session_stats WHERE session_id = ?`, oversizeSession).Scan(&turns); err != nil {
		t.Fatal(err)
	}
	if turns != lines {
		t.Fatalf("session counts %d turns, want %d", turns, lines)
	}
	fi, _ := os.Stat(path)
	if saved, _ := store.GetOffset(context.Background(), st.DB(), path); saved != fi.Size() {
		t.Fatalf("saved offset %d, file size %d", saved, fi.Size())
	}
	if n := tl.Stats().EventsStored; n != lines {
		t.Fatalf("counted %d stored events, want %d", n, lines)
	}
}

func lineBlock(n int) string {
	var b strings.Builder
	for i := 0; i < n; i++ {
		b.WriteString(turnLine(i, 0) + "\n")
	}
	return b.String()
}
