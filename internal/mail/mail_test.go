package mail

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/mail/fakemail"
	"github.com/dspv/caprock/internal/mail/secrets"
)

func newTestService(t *testing.T) *Service {
	t.Helper()
	dir := t.TempDir()
	s := New(dir, nil)
	s.sec = &secrets.Memory{} // never the real keychain in a test
	t.Cleanup(s.Close)
	return s
}

func do(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var b bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&b).Encode(body)
	}
	r := httptest.NewRequest(method, path, &b)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// Before an account exists, Mail is not even opened: no database, no goroutine.
func TestUnusedMailTouchesNothing(t *testing.T) {
	s := newTestService(t)
	w := do(t, s.Handler(), "GET", "/v1/mail/state", nil)
	if w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"accounts":[]`)) {
		t.Fatalf("state: %d %s", w.Code, w.Body)
	}
	if _, err := os.Stat(filepath.Join(s.dir, "mail.db")); !os.IsNotExist(err) {
		t.Fatal("state created mail.db before Mail was used")
	}
	if s.opened() {
		t.Fatal("state opened Mail")
	}
}

func TestAddAccountSyncsAndRefusesBadPassword(t *testing.T) {
	srv, err := fakemail.Start("me@fake.test", "pw")
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	_ = srv.Deliver("INBOX", fakemail.Msg{From: "ana@example.com", To: "me@fake.test", Subject: "hello", Body: "hi there"}.Raw())
	s := newTestService(t)
	h := s.Handler()
	ih, ip, _ := net.SplitHostPort(srv.IMAPAddr)
	sh, sp, _ := net.SplitHostPort(srv.SMTPAddr)
	ipn, _ := strconv.Atoi(ip)
	spn, _ := strconv.Atoi(sp)
	acct := map[string]any{"email": "me@fake.test", "imap_host": ih, "imap_port": ipn, "imap_tls": "none",
		"smtp_host": sh, "smtp_port": spn, "smtp_tls": "none"}

	acct["password"] = "wrong"
	if w := do(t, h, "POST", "/v1/mail/accounts", acct); w.Code != 422 {
		t.Fatalf("bad password: %d %s", w.Code, w.Body)
	}
	if s.opened() {
		t.Fatal("a refused account opened Mail")
	}
	acct["password"] = "pw"
	if w := do(t, h, "POST", "/v1/mail/accounts", acct); w.Code != 200 {
		t.Fatalf("add: %d %s", w.Code, w.Body)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		w := do(t, h, "GET", "/v1/mail/messages?view=inbox", nil)
		var ms []map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &ms)
		if len(ms) == 1 && ms[0]["subject"] == "hello" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("inbox never synced: %s", w.Body)
		}
		time.Sleep(30 * time.Millisecond)
	}
	if w := do(t, h, "POST", "/v1/mail/ai/summarize", map[string]any{"message_id": 1}); w.Code != 409 {
		t.Fatalf("AI must be off until enabled: %d", w.Code)
	}
}
