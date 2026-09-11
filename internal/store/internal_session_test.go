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
func TestInternalSessionMigrationBackfillsAndRemovesUserRollups(t *testing.T) {
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
		`INSERT INTO sessions(session_id, model, status) VALUES ('review', ' Codex-Auto-Review ', 'ended'), ('user', 'gpt-5.6-sol', 'ended')`,
		`INSERT INTO session_stats(session_id, turns, cost_usd) VALUES ('review', 2, 0), ('user', 1, 1)`,
		`INSERT INTO daily_sessions(day, project, session_id) VALUES ('2026-09-11', 'caprock', 'review'), ('2026-09-11', 'caprock', 'user')`,
		`INSERT INTO daily_stats(day, project, model, tokens_total, cost_usd, sessions) VALUES ('2026-09-11', 'caprock', 'codex-auto-review', 41000, 0, 1), ('2026-09-11', 'caprock', 'gpt-5.6-sol', 100, 1, 1)`,
	} {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, migration24); err != nil {
		t.Fatal(err)
	}

	var internal int
	if err := db.QueryRowContext(ctx, `SELECT internal FROM sessions WHERE session_id = 'review'`).Scan(&internal); err != nil || internal != 1 {
		t.Fatalf("review internal=%d err=%v", internal, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT internal FROM sessions WHERE session_id = 'user'`).Scan(&internal); err != nil || internal != 0 {
		t.Fatalf("user internal=%d err=%v", internal, err)
	}
	for name, query := range map[string]string{
		"review session stats": `SELECT COUNT(*) FROM session_stats WHERE session_id = 'review'`,
		"review daily marker":  `SELECT COUNT(*) FROM daily_sessions WHERE session_id = 'review'`,
		"review daily stats":   `SELECT COUNT(*) FROM daily_stats WHERE lower(trim(model)) = 'codex-auto-review'`,
		"user session stats":   `SELECT COUNT(*) FROM session_stats WHERE session_id = 'user'`,
		"user daily marker":    `SELECT COUNT(*) FROM daily_sessions WHERE session_id = 'user'`,
		"user daily stats":     `SELECT COUNT(*) FROM daily_stats WHERE model = 'gpt-5.6-sol'`,
	} {
		var n int
		if err := db.QueryRowContext(ctx, query).Scan(&n); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		want := 0
		if name[:4] == "user" {
			want = 1
		}
		if n != want {
			t.Errorf("%s count=%d, want %d", name, n, want)
		}
	}
}
