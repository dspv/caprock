package importer

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	_ "modernc.org/sqlite"
)

// key4Params are the fixed salts/ivs a fixture key4.db uses.
type key4Params struct {
	globalSalt []byte
	entrySalt  []byte
	iv14       []byte
	iters      int
	masterKey  []byte // 32 bytes: 3DES uses [:24], AES uses [:32]
}

func defaultKey4() key4Params {
	return key4Params{
		globalSalt: []byte("globalSALTglobalSALT"),
		entrySalt:  []byte("entrySALTentrySALTab"),
		iv14:       []byte("iv-14-bytes!!!"),
		iters:      1000,
		masterKey:  []byte("0123456789abcdef0123456789ABCDEF"),
	}
}

// writeKey4 creates a key4.db validating against checkPw ("" = no primary
// password).
func writeKey4(t *testing.T, path string, p key4Params, checkPw string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mustExec(t, db, `CREATE TABLE metadata (id TEXT PRIMARY KEY, item1 BLOB, item2 BLOB)`)
	mustExec(t, db, `CREATE TABLE nssPrivate (a11 BLOB, a102 BLOB)`)

	item2 := encodePBES2(t, []byte("password-check"), p.globalSalt, []byte(checkPw), p.entrySalt, p.iv14, p.iters)
	mustExec(t, db, `INSERT INTO metadata (id, item1, item2) VALUES ('password', ?, ?)`, p.globalSalt, item2)

	// The master key is always wrapped with the real primary password; a
	// wrong password fails the password-check before we get here.
	a11 := encodePBES2(t, p.masterKey, p.globalSalt, []byte(checkPw), p.entrySalt, p.iv14, p.iters)
	mustExec(t, db, `INSERT INTO nssPrivate (a11, a102) VALUES (?, ?)`, a11, ckaID)
}

func mustExec(t *testing.T, db *sql.DB, q string, args ...any) {
	t.Helper()
	if _, err := db.Exec(q, args...); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// writeLogins writes a logins.json for the given host/user/password triples.
func writeLogins(t *testing.T, path string, p key4Params, entries []loginFixture) {
	t.Helper()
	type rec struct {
		Hostname          string `json:"hostname"`
		EncryptedUsername string `json:"encryptedUsername"`
		EncryptedPassword string `json:"encryptedPassword"`
	}
	var lf struct {
		Logins []rec `json:"logins"`
	}
	for _, e := range entries {
		var u, pw []byte
		if e.aes {
			u = encodeLoginAES(t, []byte(e.user), p.masterKey, make([]byte, 16))
			pw = encodeLoginAES(t, []byte(e.pass), p.masterKey, []byte("sixteenbyteIVxx!"))
		} else {
			u = encodeLogin3DES(t, []byte(e.user), p.masterKey, make([]byte, 8))
			pw = encodeLogin3DES(t, []byte(e.pass), p.masterKey, []byte("8byteIV!"))
		}
		lf.Logins = append(lf.Logins, rec{Hostname: e.host, EncryptedUsername: b64(u), EncryptedPassword: b64(pw)})
	}
	b, _ := json.Marshal(lf)
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

type loginFixture struct {
	host, user, pass string
	aes              bool
}

// tbHome builds a Thunderbird home for the current OS with one profile whose
// prefs.js, key4.db and logins.json are provided by the caller.
func tbHome(t *testing.T) (home, profile string) {
	t.Helper()
	home = t.TempDir()
	var root string
	switch runtime.GOOS {
	case "darwin":
		root = filepath.Join(home, "Library", "Thunderbird")
	case "windows":
		root = filepath.Join(home, "AppData", "Roaming", "Thunderbird")
	default:
		root = filepath.Join(home, ".thunderbird")
	}
	profile = filepath.Join(root, "abc.default")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		t.Fatal(err)
	}
	ini := "[Profile0]\nName=default\nIsRelative=1\nPath=abc.default\nDefault=1\n"
	if err := os.WriteFile(filepath.Join(root, "profiles.ini"), []byte(ini), 0o600); err != nil {
		t.Fatal(err)
	}
	return home, profile
}

const twoAccountPrefs = `user_pref("mail.account.account1.server", "server1");
user_pref("mail.account.account1.identities", "id1");
user_pref("mail.account.account2.server", "server2");
user_pref("mail.account.account2.identities", "id2");
user_pref("mail.account.account3.server", "server3");
user_pref("mail.server.server1.type", "imap");
user_pref("mail.server.server1.hostname", "imap.example.com");
user_pref("mail.server.server1.port", 993);
user_pref("mail.server.server1.socketType", 3);
user_pref("mail.server.server1.userName", "alice");
user_pref("mail.server.server2.type", "imap");
user_pref("mail.server.server2.hostname", "imap.work.test");
user_pref("mail.server.server2.port", 143);
user_pref("mail.server.server2.socketType", 2);
user_pref("mail.server.server2.userName", "bob@work.test");
user_pref("mail.server.server3.type", "pop3");
user_pref("mail.server.server3.hostname", "pop.ignored.test");
user_pref("mail.identity.id1.useremail", "alice@example.com");
user_pref("mail.identity.id1.fullName", "Alice A");
user_pref("mail.identity.id1.smtpServer", "smtp1");
user_pref("mail.identity.id2.useremail", "bob@work.test");
user_pref("mail.identity.id2.smtpServer", "smtp2");
user_pref("mail.smtpserver.smtp1.hostname", "smtp.example.com");
user_pref("mail.smtpserver.smtp1.port", 465);
user_pref("mail.smtpserver.smtp1.try_ssl", 3);
user_pref("mail.smtpserver.smtp2.hostname", "smtp.work.test");
user_pref("mail.smtpserver.smtp2.port", 587);
user_pref("mail.smtpserver.smtp2.try_ssl", 2);
`

func TestThunderbirdImportsAccountsAndPasswords(t *testing.T) {
	home, profile := tbHome(t)
	p := defaultKey4()
	if err := os.WriteFile(filepath.Join(profile, "prefs.js"), []byte(twoAccountPrefs), 0o600); err != nil {
		t.Fatal(err)
	}
	writeKey4(t, filepath.Join(profile, "key4.db"), p, "")
	writeLogins(t, filepath.Join(profile, "logins.json"), p, []loginFixture{
		{host: "imap://imap.example.com", user: "alice", pass: "alice-secret"},              // 3DES
		{host: "imap://imap.work.test", user: "bob@work.test", pass: "bob-pass", aes: true}, // AES
	})

	srcs := Sources(home)
	tb := findSource(t, srcs, "thunderbird")
	if len(tb.Accounts) != 2 {
		t.Fatalf("want 2 imap accounts (pop3 skipped), got %d: %+v", len(tb.Accounts), tb.Accounts)
	}

	alice := accountByEmail(t, tb, "alice@example.com")
	if alice.IMAPHost != "imap.example.com" || alice.IMAPPort != 993 || alice.IMAPTLS != "tls" {
		t.Errorf("alice imap wrong: %+v", alice)
	}
	if alice.SMTPHost != "smtp.example.com" || alice.SMTPPort != 465 || alice.SMTPTLS != "tls" {
		t.Errorf("alice smtp wrong: %+v", alice)
	}
	if alice.Name != "Alice A" || alice.Username != "alice" || !alice.HasPassword {
		t.Errorf("alice identity wrong: %+v", alice)
	}
	if pw, ok := tb.Password("alice@example.com"); !ok || pw != "alice-secret" {
		t.Errorf("alice password: %q ok=%v", pw, ok)
	}

	bob := accountByEmail(t, tb, "bob@work.test")
	if bob.IMAPTLS != "starttls" || bob.SMTPTLS != "starttls" || bob.SMTPPort != 587 {
		t.Errorf("bob tls/smtp wrong: %+v", bob)
	}
	if pw, ok := tb.Password("bob@work.test"); !ok || pw != "bob-pass" {
		t.Errorf("bob password (AES): %q ok=%v", pw, ok)
	}
}

func TestThunderbirdPrimaryPasswordImportsSettingsOnly(t *testing.T) {
	home, profile := tbHome(t)
	p := defaultKey4()
	if err := os.WriteFile(filepath.Join(profile, "prefs.js"), []byte(twoAccountPrefs), 0o600); err != nil {
		t.Fatal(err)
	}
	// key4.db validates only against a real primary password, so an empty
	// password fails the check: settings import, passwords do not.
	writeKey4(t, filepath.Join(profile, "key4.db"), p, "the-primary-password")
	writeLogins(t, filepath.Join(profile, "logins.json"), p, []loginFixture{
		{host: "imap://imap.example.com", user: "alice", pass: "alice-secret"},
	})

	tb := findSource(t, Sources(home), "thunderbird")
	for _, a := range tb.Accounts {
		if a.HasPassword {
			t.Errorf("%s should not have a password behind a primary password", a.Email)
		}
	}
	if _, ok := tb.Password("alice@example.com"); ok {
		t.Error("no password should be recovered behind a primary password")
	}
	if tb.Error == "" {
		t.Error("want an Error explaining the primary password")
	}
	if len(tb.Accounts) != 2 {
		t.Errorf("settings should still import: got %d accounts", len(tb.Accounts))
	}
}

func findSource(t *testing.T, srcs []Source, kind string) Source {
	t.Helper()
	for _, s := range srcs {
		if s.Kind == kind {
			return s
		}
	}
	t.Fatalf("source %q not found in %+v", kind, srcs)
	return Source{}
}

func accountByEmail(t *testing.T, s Source, email string) Account {
	t.Helper()
	for _, a := range s.Accounts {
		if a.Email == email {
			return a
		}
	}
	t.Fatalf("account %q not found in %+v", email, s.Accounts)
	return Account{}
}
