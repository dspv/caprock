package mail

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/mail/fakemail"
)

// tbFixtureHome writes a Thunderbird profile whose single IMAP account points
// at the given fake servers, and returns the home dir to point a Service at.
// It writes no key4.db/logins.json, so the account has no recoverable password
// and the import must be given one in the request.
func tbFixtureHome(t *testing.T, email, imapHost string, imapPort int, smtpHost string, smtpPort int) string {
	t.Helper()
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
	prof := filepath.Join(root, "p.default")
	if err := os.MkdirAll(prof, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "profiles.ini"),
		[]byte("[Profile0]\nName=default\nIsRelative=1\nPath=p.default\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	prefs := fmt.Sprintf(`user_pref("mail.account.account1.server", "server1");
user_pref("mail.account.account1.identities", "id1");
user_pref("mail.server.server1.type", "imap");
user_pref("mail.server.server1.hostname", %q);
user_pref("mail.server.server1.port", %d);
user_pref("mail.server.server1.socketType", 0);
user_pref("mail.server.server1.userName", %q);
user_pref("mail.identity.id1.useremail", %q);
user_pref("mail.identity.id1.fullName", "Imported User");
user_pref("mail.identity.id1.smtpServer", "smtp1");
user_pref("mail.smtpserver.smtp1.hostname", %q);
user_pref("mail.smtpserver.smtp1.port", %d);
user_pref("mail.smtpserver.smtp1.try_ssl", 0);
`, imapHost, imapPort, email, email, smtpHost, smtpPort)
	if err := os.WriteFile(filepath.Join(prof, "prefs.js"), []byte(prefs), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestImportSourcesTouchesNothing(t *testing.T) {
	s := newTestService(t)
	s.home = t.TempDir() // no mail clients installed
	w := do(t, s.Handler(), "GET", "/v1/mail/import", nil)
	if w.Code != 200 {
		t.Fatalf("import sources: %d %s", w.Code, w.Body)
	}
	if _, err := os.Stat(filepath.Join(s.dir, "mail.db")); !os.IsNotExist(err) {
		t.Fatal("listing import sources created mail.db")
	}
	if s.opened() {
		t.Fatal("listing import sources opened Mail")
	}
}

func TestImportAccountsAddsAndVerifies(t *testing.T) {
	srv, err := fakemail.Start("me@fake.test", "pw")
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	_ = srv.Deliver("INBOX", fakemail.Msg{From: "a@example.com", To: "me@fake.test", Subject: "hi", Body: "yo"}.Raw())

	ih, ip, _ := net.SplitHostPort(srv.IMAPAddr)
	sh, sp, _ := net.SplitHostPort(srv.SMTPAddr)
	ipn, _ := strconv.Atoi(ip)
	spn, _ := strconv.Atoi(sp)

	s := newTestService(t)
	s.home = tbFixtureHome(t, "me@fake.test", ih, ipn, sh, spn)
	h := s.Handler()

	// The source lists the account with no recovered password.
	w := do(t, h, "GET", "/v1/mail/import", nil)
	var sr struct {
		Sources []struct {
			Kind     string `json:"kind"`
			Accounts []struct {
				Email       string `json:"email"`
				HasPassword bool   `json:"has_password"`
			} `json:"accounts"`
		} `json:"sources"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &sr); err != nil {
		t.Fatalf("decode sources: %v (%s)", err, w.Body)
	}
	if bytes.Contains(w.Body.Bytes(), []byte("password")) && bytes.Contains(w.Body.Bytes(), []byte(`"pw"`)) {
		t.Fatal("a password leaked into the sources listing")
	}
	var found bool
	for _, src := range sr.Sources {
		if src.Kind == "thunderbird" {
			for _, a := range src.Accounts {
				if a.Email == "me@fake.test" && !a.HasPassword {
					found = true
				}
			}
		}
	}
	if !found {
		t.Fatalf("thunderbird account not listed without a password: %s", w.Body)
	}

	// Import it with the right password and a second (unknown) account with a
	// wrong one: the good one succeeds, the bad one fails, neither stops the other.
	body := map[string]any{
		"source": "thunderbird",
		"emails": []string{"me@fake.test", "ghost@fake.test"},
		"passwords": map[string]string{
			"me@fake.test":    "pw",
			"ghost@fake.test": "nope",
		},
	}
	w = do(t, h, "POST", "/v1/mail/import", body)
	if w.Code != 200 {
		t.Fatalf("import: %d %s", w.Code, w.Body)
	}
	var out struct {
		Results []struct {
			Email string `json:"email"`
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		} `json:"results"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode results: %v", err)
	}
	if len(out.Results) != 2 {
		t.Fatalf("want 2 results, got %d: %s", len(out.Results), w.Body)
	}
	byEmail := map[string]struct {
		ok  bool
		err string
	}{}
	for _, r := range out.Results {
		byEmail[r.Email] = struct {
			ok  bool
			err string
		}{r.OK, r.Error}
	}
	if !byEmail["me@fake.test"].ok {
		t.Errorf("good account should import: %+v", byEmail["me@fake.test"])
	}
	if byEmail["ghost@fake.test"].ok || byEmail["ghost@fake.test"].err == "" {
		t.Errorf("unknown account should fail: %+v", byEmail["ghost@fake.test"])
	}

	// The imported account now syncs its inbox.
	deadline := time.Now().Add(10 * time.Second)
	for {
		w := do(t, h, "GET", "/v1/mail/messages?view=inbox", nil)
		var ms []map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &ms)
		if len(ms) == 1 && ms[0]["subject"] == "hi" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("imported inbox never synced: %s", w.Body)
		}
		time.Sleep(30 * time.Millisecond)
	}
}
