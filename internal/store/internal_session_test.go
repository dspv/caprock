package store

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

// The migration must repair an existing installation, not merely classify
// events written after upgrade. Build the pre-0024 schema from the real
// migration files, seed the rollups old releases produced, then run the exact
// SQL that ships.
//
// The classification is per-event, because Codex's auto-review reuses the
// session id of the session it reviews: a session can hold real gpt-5.6-sol
// turns and review turns side by side, and flagging the whole session would
// hide the real work.
func TestInternalEventMigrationBackfillsAndRemovesUserRollups(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:internal-migration?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	migrations, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	var migration24 string
	for _, m := range migrations {
		if m.version < 24 {
			if _, err := db.ExecContext(ctx, m.sql); err != nil {
				t.Fatalf("apply %s: %v", m.name, err)
			}
		}
		if m.version == 24 {
			migration24 = m.sql
		}
	}
	if migration24 == "" {
		t.Fatal("migration 0024 not embedded")
	}

	for _, stmt := range []string{
		`INSERT INTO sessions(session_id, model, status) VALUES ('shared', 'gpt-5.6-sol', 'ended'), ('review', ' Codex-Auto-Review ', 'ended'), ('user', 'gpt-5.6-sol', 'ended')`,
		// 'shared' mixes a real turn and a review turn; 'review' is review-only.
		`INSERT INTO events(ts, session_id, source, kind, payload, model, tokens_in, tokens_out, cache_read, cache_write, cost_usd) VALUES
			(1789120000000, 'shared', 'codex', 'turn.assistant', '{}', 'gpt-5.6-sol', 1000, 100, 0, 0, 0.5),
			(1789120060000, 'shared', 'codex', 'turn.assistant', '{}', 'codex-auto-review', 30000, 1000, 10000, 0, NULL),
			(1789120000000, 'review', 'codex', 'turn.assistant', '{}', ' Codex-Auto-Review ', 30000, 1000, 10000, 0, NULL),
			(1789120000000, 'user', 'codex', 'turn.assistant', '{}', 'gpt-5.6-sol', 100, 10, 0, 0, 1.0)`,
		// 'shared' is inflated (it counted the review turn); files_touched is a
		// first-touch count the migration must carry over, not recompute.
		`INSERT INTO session_stats(session_id, turns, tool_calls, files_touched, tokens_in, tokens_out, cache_read, cache_write, cost_usd) VALUES
			('shared', 2, 0, 3, 31000, 1100, 10000, 0, 0.5),
			('review', 1, 0, 0, 30000, 1000, 10000, 0, 0),
			('user', 1, 0, 0, 100, 10, 0, 0, 1.0)`,
		`INSERT INTO daily_sessions(day, project, session_id) VALUES ('2026-09-11', 'caprock', 'shared'), ('2026-09-11', 'caprock', 'review'), ('2026-09-11', 'caprock', 'user')`,
		`INSERT INTO daily_stats(day, project, model, tokens_total, cost_usd, sessions) VALUES ('2026-09-11', 'caprock', 'codex-auto-review', 41000, 0, 1), ('2026-09-11', 'caprock', 'gpt-5.6-sol', 100, 1, 1)`,
	} {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, migration24); err != nil {
		t.Fatal(err)
	}

	// The flag lands on the review events, not the real ones beside them.
	var realInternal, reviewInternal int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE model = 'gpt-5.6-sol' AND internal = 1`).Scan(&realInternal); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE lower(trim(model)) = 'codex-auto-review' AND internal = 1`).Scan(&reviewInternal); err != nil {
		t.Fatal(err)
	}
	if realInternal != 0 || reviewInternal != 2 {
		t.Fatalf("internal flags wrong: real=%d review=%d", realInternal, reviewInternal)
	}

	// session_stats: 'shared' is recomputed from its non-review events (keeping
	// files_touched), 'review' is deleted, 'user' is untouched.
	for _, c := range []struct {
		session string
		wantRow bool
		turns   int
		tokens  int
		files   int
	}{
		{"shared", true, 1, 1000, 3},
		{"review", false, 0, 0, 0},
		{"user", true, 1, 100, 0},
	} {
		var turns, tokens, files int
		err := db.QueryRowContext(ctx, `SELECT COALESCE(turns,0), COALESCE(tokens_in,0), COALESCE(files_touched,0) FROM session_stats WHERE session_id = ?`, c.session).Scan(&turns, &tokens, &files)
		if c.wantRow {
			if err != nil {
				t.Fatalf("%s: %v", c.session, err)
			}
			if turns != c.turns || tokens != c.tokens || files != c.files {
				t.Errorf("%s: turns=%d tokens=%d files=%d, want %d/%d/%d", c.session, turns, tokens, files, c.turns, c.tokens, c.files)
			}
		} else if err != sql.ErrNoRows {
			t.Errorf("%s: expected no row, got turns=%d err=%v", c.session, turns, err)
		}
	}

	// daily_stats drops the review model's row; daily_sessions drops only the
	// review-only session's markers.
	for name, query := range map[string]string{
		"review daily stats":  `SELECT COUNT(*) FROM daily_stats WHERE lower(trim(model)) = 'codex-auto-review'`,
		"real daily stats":    `SELECT COUNT(*) FROM daily_stats WHERE model = 'gpt-5.6-sol'`,
		"review daily marker": `SELECT COUNT(*) FROM daily_sessions WHERE session_id = 'review'`,
		"shared daily marker": `SELECT COUNT(*) FROM daily_sessions WHERE session_id = 'shared'`,
		"user daily marker":   `SELECT COUNT(*) FROM daily_sessions WHERE session_id = 'user'`,
	} {
		var n int
		if err := db.QueryRowContext(ctx, query).Scan(&n); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		want := 1
		if name[:6] == "review" {
			want = 0
		}
		if n != want {
			t.Errorf("%s count=%d, want %d", name, n, want)
		}
	}
}
