package mailstore

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

// A mail.db made before accounts had an auth column gains it on open, its
// accounts read as password accounts, and opening again changes nothing.
func TestOpenAddsAuthToAnOlderFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mail.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE accounts (
		id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL, username TEXT NOT NULL,
		imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, imap_tls TEXT NOT NULL DEFAULT 'tls',
		smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, smtp_tls TEXT NOT NULL DEFAULT 'tls',
		color TEXT NOT NULL DEFAULT '', signature TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
		last_sync INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '');
		INSERT INTO accounts (email, username, imap_host, imap_port, smtp_host, smtp_port, created_at)
		VALUES ('a@x.example', 'a@x.example', 'imap.x.example', 993, 'smtp.x.example', 465, 1)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	for i := 0; i < 2; i++ {
		st, err := Open(path)
		if err != nil {
			t.Fatalf("open %d: %v", i, err)
		}
		a, err := st.Account(context.Background(), 1)
		if err != nil || a.Auth != "password" {
			t.Fatalf("open %d: auth = %q, %v", i, a.Auth, err)
		}
		if err := st.SetAuth(context.Background(), 1, "oauth2:microsoft"); err != nil {
			t.Fatal(err)
		}
		if err := st.SetAuth(context.Background(), 1, ""); err != nil {
			t.Fatal(err)
		}
		st.Close()
	}
}
