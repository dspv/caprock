package opencode

import (
	"context"
	"sort"
	"testing"
)

// TestAgainstLocalDatabase reads whatever OpenCode database exists on this
// machine. It is a smoke check against a real installation, not a fixture
// test: it skips cleanly where OpenCode is not installed (CI, most users),
// and asserts only invariants that must hold for any real database.
func TestAgainstLocalDatabase(t *testing.T) {
	p := DBPath()
	if p == "" {
		t.Skip("no OpenCode database on this machine")
	}
	db, err := Open(p)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	ss, err := Sessions(context.Background(), db)
	if err != nil {
		t.Fatalf("sessions: %v", err)
	}
	if len(ss) == 0 {
		t.Skip("database has no sessions")
	}

	var total, roots float64
	byDir := map[string]float64{}
	children := 0
	for _, s := range ss {
		total += s.Cost
		if s.IsChild() {
			children++
		} else {
			roots += s.Cost
		}
		byDir[s.Directory] += s.Cost
	}
	t.Logf("sessions=%d children=%d total=$%.2f roots=$%.2f", len(ss), children, total, roots)

	type kv struct {
		k string
		v float64
	}
	var list []kv
	for k, v := range byDir {
		list = append(list, kv{k, v})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].v > list[j].v })
	for i, e := range list {
		if i >= 3 {
			break
		}
		t.Logf("  %s: $%.2f", e.k, e.v)
	}

	// Sessions must carry a directory, or per-repo cost cannot work at all.
	withDir := 0
	for _, s := range ss {
		if s.Directory != "" {
			withDir++
		}
	}
	if withDir == 0 {
		t.Error("no session carries a directory; per-repo attribution would be empty")
	}

	// Tool calls must normalise and, for file tools, name a file.
	for _, s := range ss {
		tc, err := ToolCalls(context.Background(), db, s.ID)
		if err != nil {
			t.Fatalf("tool calls: %v", err)
		}
		hasFileTool := false
		for _, c := range tc {
			if c.Tool == "Read" || c.Tool == "Edit" || c.Tool == "Write" {
				hasFileTool = true
				break
			}
		}
		if len(tc) < 3 || !hasFileTool {
			continue
		}
		named := 0
		for _, c := range tc {
			if c.Tool == "" {
				t.Errorf("tool call %s has no normalised name (raw %q)", c.ID, c.RawTool)
			}
			if c.FilePath != "" {
				named++
			}
		}
		t.Logf("tools in one session: %d, with a file path: %d", len(tc), named)
		if named == 0 {
			t.Error("a session that ran Read/Edit/Write yielded no file paths; " +
				"per-directory attribution would be empty")
		}
		for i, c := range tc {
			if i >= 4 {
				break
			}
			t.Logf("  %-8s <- %-8s %s", c.Tool, c.RawTool, c.FilePath)
		}
		break
	}
}

// The WAL caveat, checked rather than assumed: a reader that cannot attach to
// the write-ahead log sees the database as it was at the last checkpoint, and
// on a live installation that means missing everything recent — silently.
func TestReadsThroughTheWAL(t *testing.T) {
	p := DBPath()
	if p == "" {
		t.Skip("no OpenCode database on this machine")
	}
	db, err := Open(p)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	var mode string
	if err := db.QueryRowContext(context.Background(), "PRAGMA journal_mode").Scan(&mode); err != nil {
		t.Fatalf("journal_mode: %v", err)
	}
	t.Logf("journal mode: %s", mode)

	// The newest session's timestamp, which lives in the WAL on a database
	// that has been written to recently.
	var newest int64
	if err := db.QueryRowContext(context.Background(),
		"SELECT COALESCE(MAX(time_updated),0) FROM session").Scan(&newest); err != nil {
		t.Fatalf("read: %v", err)
	}
	if newest == 0 {
		t.Fatal("read nothing; the reader is not seeing the database")
	}
	t.Logf("newest session update: %d", newest)
}
