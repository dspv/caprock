package mailstore

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

// A mail.db made before the junk filter gains its columns and tables on open,
// learns who the user wrote to from the Sent mail already stored, and opening
// again changes nothing.
func TestOpenAddsTheJunkFilterToAnOlderFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mail.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL, username TEXT NOT NULL,
			imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, imap_tls TEXT NOT NULL DEFAULT 'tls',
			smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, smtp_tls TEXT NOT NULL DEFAULT 'tls',
			color TEXT NOT NULL DEFAULT '', signature TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
			last_sync INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', auth TEXT NOT NULL DEFAULT 'password');
		CREATE TABLE folders (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, name TEXT NOT NULL, delim TEXT NOT NULL DEFAULT '/',
			role TEXT NOT NULL DEFAULT '', uidvalidity INTEGER NOT NULL DEFAULT 0, last_uid INTEGER NOT NULL DEFAULT 0,
			total INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0, UNIQUE (account_id, name));
		CREATE TABLE messages (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, folder_id INTEGER NOT NULL, uid INTEGER NOT NULL,
			message_id TEXT NOT NULL DEFAULT '', in_reply_to TEXT NOT NULL DEFAULT '', refs TEXT NOT NULL DEFAULT '',
			thread_key TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', from_name TEXT NOT NULL DEFAULT '',
			from_addr TEXT NOT NULL DEFAULT '', to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]',
			reply_to TEXT NOT NULL DEFAULT '', date INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0,
			seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, answered INTEGER NOT NULL DEFAULT 0,
			has_attach INTEGER NOT NULL DEFAULT 0, snippet TEXT NOT NULL DEFAULT '', body_text TEXT NOT NULL DEFAULT '',
			body_html TEXT NOT NULL DEFAULT '', structure TEXT NOT NULL DEFAULT '', body_state INTEGER NOT NULL DEFAULT 0,
			UNIQUE (folder_id, uid));
		CREATE TABLE contacts (addr TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', weight INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0);
		INSERT INTO accounts (email, username, imap_host, imap_port, smtp_host, smtp_port, created_at)
			VALUES ('me@x.example', 'me@x.example', 'imap.x.example', 993, 'smtp.x.example', 465, 1);
		INSERT INTO folders (account_id, name, role) VALUES (1, 'INBOX', 'inbox'), (1, 'Sent', 'sent');
		INSERT INTO messages (account_id, folder_id, uid, subject, from_addr, to_json)
			VALUES (1, 2, 1, 'Hi', 'me@x.example', '[{"name":"Rui","addr":"Rui@Firm.example"}]'),
			       (1, 1, 1, 'Hello', 'stranger@y.example', '[]');
		INSERT INTO contacts (addr, weight) VALUES ('rui@firm.example', 6), ('stranger@y.example', 1);`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		st, err := Open(path)
		if err != nil {
			t.Fatalf("open %d: %v", i, err)
		}
		if k, _ := st.KnownSender(ctx, "rui@firm.example"); !k {
			t.Fatalf("open %d: someone the user wrote to is not known", i)
		}
		if k, _ := st.KnownSender(ctx, "stranger@y.example"); k {
			t.Fatalf("open %d: a stranger who wrote in is known", i)
		}
		ms, err := st.List(ctx, Query{View: "inbox"})
		if err != nil || len(ms) != 1 || ms[0].Junk {
			t.Fatalf("open %d: inbox %+v %v", i, ms, err)
		}
		st.Close()
	}
}

func TestLearnMovesAcrossAndPrunes(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "mail.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	id, _ := st.AddAccount(ctx, Account{Email: "me@x.example", Username: "me", IMAPHost: "i", SMTPHost: "s"})
	toks := []string{"casino", "bonus", "s:win"}
	if ok, err := st.Learn(ctx, id, "m1", toks, true, false); !ok || err != nil {
		t.Fatalf("learn: %v %v", ok, err)
	}
	if ok, _ := st.Learn(ctx, id, "m1", toks, true, false); ok {
		t.Fatal("the same lesson counted twice")
	}
	if s, h := st.JunkTotals(ctx); s != 1 || h != 0 {
		t.Fatalf("totals %d %d", s, h)
	}
	// The user changes their mind: the tokens move from spam to ham.
	if ok, _ := st.Learn(ctx, id, "m1", toks, false, true); !ok {
		t.Fatal("not spam after spam was ignored")
	}
	c, _ := st.TokenCounts(ctx, toks)
	if c["casino"] != [2]int{0, 1} {
		t.Fatalf("casino counts %v", c["casino"])
	}
	if s, h := st.JunkTotals(ctx); s != 0 || h != 1 {
		t.Fatalf("totals after the change %d %d", s, h)
	}
	// An automatic lesson never overrides the user's.
	if ok, _ := st.Learn(ctx, id, "m1", toks, true, false); ok {
		t.Fatal("automatic lesson overrode the user's")
	}
	_, _ = st.Learn(ctx, id, "m2", []string{"casino"}, false, false)
	for i := 0; i < 30; i++ {
		_, _ = st.Learn(ctx, id, "k"+string(rune('a'+i)), []string{"rare" + string(rune('a'+i))}, true, false)
	}
	if err := st.PruneJunkTokens(ctx, 10); err != nil {
		t.Fatal(err)
	}
	if n, _ := st.JunkTokenCount(ctx); n > 10 {
		t.Fatalf("pruned to %d tokens", n)
	}
	// Pruning keeps the most-seen tokens.
	if c, _ := st.TokenCounts(ctx, []string{"casino"}); c["casino"][1] != 2 {
		t.Fatal("pruning dropped a token seen in more than one message")
	}
}
