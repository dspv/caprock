package importer

import (
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func TestMergeListsAnAddressOnceAndPrefersTheSavedPassword(t *testing.T) {
	tb := Source{Kind: "thunderbird", Accounts: []Account{
		{Email: "Ana@Example.com", Name: "", IMAPHost: "imap.example.com", HasPassword: true},
		{Email: "me@gmail.com", Name: "Me", IMAPHost: "imap.gmail.com"},
	}}
	am := Source{Kind: "apple_mail", Accounts: []Account{
		{Email: "ana@example.com", Name: "Ana A", IMAPHost: "imap.example.com"},
		{Email: "me@gmail.com", Name: "Me Too", IMAPHost: "imap.gmail.com"},
		{Email: "me@icloud.com", IMAPHost: "imap.mail.me.com"},
		{Email: "", IMAPHost: "nowhere"},
	}}
	got := Merge([]Source{tb, am})
	if len(got) != 3 {
		t.Fatalf("want 3 accounts, got %d: %+v", len(got), got)
	}
	ana := got[0]
	if ana.Source != "thunderbird" || !ana.HasPassword || ana.Name != "Ana A" {
		t.Errorf("ana: want the Thunderbird row with its password and Apple's name, got %+v", ana)
	}
	if !reflect.DeepEqual(ana.From, []string{"thunderbird", "apple_mail"}) {
		t.Errorf("ana from: %v", ana.From)
	}
	if got[1].Email != "me@gmail.com" || got[1].Name != "Me" || got[1].Provider != "google" || got[1].Source != "thunderbird" {
		t.Errorf("gmail: first seen wins when neither has a password, got %+v", got[1])
	}
	if got[2].Provider != "icloud" || got[2].Source != "apple_mail" {
		t.Errorf("icloud: %+v", got[2])
	}

	// A saved password found later still wins.
	got = Merge([]Source{am, tb})
	if got[0].Source != "thunderbird" || !got[0].HasPassword || got[0].Name != "Ana A" {
		t.Errorf("later password: %+v", got[0])
	}
	if !reflect.DeepEqual(got[0].From, []string{"apple_mail", "thunderbird"}) {
		t.Errorf("later from: %v", got[0].From)
	}
	if out := Merge(nil); out == nil || len(out) != 0 {
		t.Errorf("nothing found is an empty list, never null: %#v", out)
	}
}

func TestProviderFor(t *testing.T) {
	for _, c := range []struct{ email, host, want string }{
		{"a@gmail.com", "", "google"},
		{"a@company.io", "imap.gmail.com", "google"},
		{"a@me.com", "", "icloud"},
		{"a@custom.dev", "imap.mail.me.com", "icloud"},
		{"a@hotmail.co.uk", "", "microsoft"},
		{"a@corp.example", "outlook.office365.com", "microsoft"},
		{"a@yahoo.com", "", "yahoo"},
		{"a@fastmail.com", "", "fastmail"},
		{"a@example.org", "mail.example.org", ""},
		{"a@notgmail.com", "imap.notgmail.com", ""},
	} {
		if got := ProviderFor(c.email, c.host); got != c.want {
			t.Errorf("ProviderFor(%q, %q) = %q, want %q", c.email, c.host, got, c.want)
		}
	}
}

// Accounts added in System Settings › Internet Accounts carry no IMAP
// settings: they land on their provider's servers.
func TestAppleMailReadsInternetAccounts(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Apple Mail import is macOS-only")
	}
	home, accounts4 := appleHome(t)
	writeAccounts4(t, accounts4)
	db := openFixture(t, accounts4)
	mustExec(t, db, `INSERT INTO ZACCOUNTTYPE VALUES (3,'com.apple.account.Google')`)
	mustExec(t, db, `INSERT INTO ZACCOUNTTYPE VALUES (4,'com.apple.account.AppleAccount')`)
	mustExec(t, db, `INSERT INTO ZACCOUNTTYPE VALUES (5,'com.apple.account.IMAPMail')`)
	mustExec(t, db, `INSERT INTO ZACCOUNTTYPE VALUES (6,'com.apple.account.Exchange')`)
	mustExec(t, db, `INSERT INTO ZACCOUNTTYPE VALUES (7,'com.apple.account.CalDAV')`)
	mustExec(t, db, `INSERT INTO ZACCOUNT VALUES (30,'G','greta.g@gmail.com','Google',3,NULL)`)
	mustExec(t, db, `INSERT INTO ZACCOUNT VALUES (40,'A','greta@example.org','iCloud',4,NULL)`)
	mustExec(t, db, `INSERT INTO ZACCOUNT VALUES (41,'AM','greta@icloud.com','',5,40)`)
	mustExec(t, db, `INSERT INTO ZACCOUNT VALUES (50,'A2','other@me.com','iCloud',4,NULL)`)
	mustExec(t, db, `INSERT INTO ZACCOUNT VALUES (60,'E','greta@outlook.com','Work',6,NULL)`)
	mustExec(t, db, `INSERT INTO ZACCOUNT VALUES (70,'C','greta@caldav.example','',7,NULL)`)
	db.Close()

	src := findSource(t, Sources(home), "apple_mail")
	by := map[string]Account{}
	for _, a := range src.Accounts {
		by[a.Email] = a
	}
	if len(src.Accounts) != 5 {
		t.Fatalf("want fastmail + google + 2 icloud + exchange, got %+v", src.Accounts)
	}
	if g := by["greta.g@gmail.com"]; g.IMAPHost != "imap.gmail.com" || g.SMTPHost != "smtp.gmail.com" || g.Provider != "google" || g.Name != "" {
		t.Errorf("google: %+v", g)
	}
	if c := by["greta@icloud.com"]; c.IMAPHost != "imap.mail.me.com" || c.Provider != "icloud" {
		t.Errorf("icloud from its mail child: %+v", c)
	}
	if _, ok := by["greta@example.org"]; ok {
		t.Error("an Apple Account on a non-iCloud address is not a mailbox")
	}
	if c := by["other@me.com"]; c.Provider != "icloud" {
		t.Errorf("icloud by its own address: %+v", c)
	}
	if e := by["greta@outlook.com"]; e.IMAPHost != "outlook.office365.com" || e.Provider != "microsoft" || e.Name != "Work" {
		t.Errorf("exchange: %+v", e)
	}
	for _, a := range src.Accounts {
		if a.HasPassword {
			t.Errorf("%s: Apple Mail never has a password", a.Email)
		}
	}
}

func TestSourcesTagProviders(t *testing.T) {
	home := t.TempDir()
	var root string
	switch runtime.GOOS {
	case "darwin":
		root = filepath.Join(home, "Library", "Thunderbird")
	case "windows":
		root = filepath.Join(home, "AppData", "Roaming", "Thunderbird")
	default:
		root = filepath.Join(home, ".thunderbird")
	}
	prof := filepath.Join(root, "p")
	if err := os.MkdirAll(prof, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "profiles.ini"), []byte("[Profile0]\nIsRelative=1\nPath=p\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	prefs := `user_pref("mail.account.account1.server", "server1");
user_pref("mail.account.account1.identities", "id1");
user_pref("mail.server.server1.type", "imap");
user_pref("mail.server.server1.hostname", "imap.gmail.com");
user_pref("mail.server.server1.userName", "x@gmail.com");
user_pref("mail.identity.id1.useremail", "x@gmail.com");
`
	if err := os.WriteFile(filepath.Join(prof, "prefs.js"), []byte(prefs), 0o600); err != nil {
		t.Fatal(err)
	}
	src := findSource(t, Sources(home), "thunderbird")
	if len(src.Accounts) != 1 || src.Accounts[0].Provider != "google" {
		t.Fatalf("want one google account, got %+v", src.Accounts)
	}
}

func openFixture(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	return db
}
