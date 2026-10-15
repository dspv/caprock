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
	"strings"
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
	if w := do(t, s.Handler(), "GET", "/v1/mail/messages?view=inbox", nil); w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("list: %d %s", w.Code, w.Body)
	}
	// The screen reads its settings on open, before any account exists.
	if w := do(t, s.Handler(), "GET", "/v1/mail/settings", nil); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"remote_images":"ask"`)) {
		t.Fatalf("settings: %d %s", w.Code, w.Body)
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

func stateOf(t *testing.T, h http.Handler) (accounts []map[string]any, sample bool) {
	t.Helper()
	w := do(t, h, "GET", "/v1/mail/state", nil)
	var st struct {
		Accounts []map[string]any `json:"accounts"`
		Sample   bool             `json:"sample"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &st) != nil {
		t.Fatalf("state: %d %s", w.Code, w.Body)
	}
	return st.Accounts, st.Sample
}

// Sample mode on an unused Mail serves sample accounts and, turned off,
// leaves nothing behind: no mail.db, nothing opened, no password stored.
func TestSampleModeOnUnusedMailLeavesNothing(t *testing.T) {
	s := newTestService(t)
	real := s.sec.(*secrets.Memory)
	h := s.Handler()
	if w := do(t, h, "POST", "/v1/mail/sample", map[string]any{"on": true}); w.Code != 200 {
		t.Fatalf("sample on: %d %s", w.Code, w.Body)
	}
	accts, sample := stateOf(t, h)
	if !sample || len(accts) != 2 {
		t.Fatalf("sample state: sample=%v accounts=%d", sample, len(accts))
	}
	if w := do(t, h, "GET", "/v1/mail/messages?view=all", nil); w.Code != 200 {
		t.Fatalf("sample list: %d %s", w.Code, w.Body)
	}
	if _, err := real.Get(1); err == nil {
		t.Fatal("sample mode stored a password in the real store")
	}
	if w := do(t, h, "POST", "/v1/mail/sample", map[string]any{"on": false}); w.Code != 200 {
		t.Fatalf("sample off: %d %s", w.Code, w.Body)
	}
	accts, sample = stateOf(t, h)
	if sample || len(accts) != 0 {
		t.Fatalf("after sample: sample=%v accounts=%d", sample, len(accts))
	}
	if s.opened() {
		t.Fatal("sample mode left Mail open")
	}
	if _, err := os.Stat(filepath.Join(s.dir, "mail.db")); !os.IsNotExist(err) {
		t.Fatal("sample mode created the real mail.db")
	}
}

// Sample mode hides real accounts while on and gives them back untouched.
func TestSampleModeKeepsRealAccounts(t *testing.T) {
	srv, err := fakemail.Start("me@fake.test", "pw")
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	s := newTestService(t)
	h := s.Handler()
	ih, ip, _ := net.SplitHostPort(srv.IMAPAddr)
	sh, sp, _ := net.SplitHostPort(srv.SMTPAddr)
	ipn, _ := strconv.Atoi(ip)
	spn, _ := strconv.Atoi(sp)
	if w := do(t, h, "POST", "/v1/mail/accounts", map[string]any{"email": "me@fake.test", "password": "pw",
		"imap_host": ih, "imap_port": ipn, "imap_tls": "none", "smtp_host": sh, "smtp_port": spn, "smtp_tls": "none"}); w.Code != 200 {
		t.Fatalf("add: %d %s", w.Code, w.Body)
	}
	do(t, h, "POST", "/v1/mail/sample", map[string]any{"on": true})
	accts, sample := stateOf(t, h)
	if !sample || len(accts) != 2 || accts[0]["email"] == "me@fake.test" || accts[1]["email"] == "me@fake.test" {
		t.Fatalf("sample must hide the real account: %v", accts)
	}
	do(t, h, "POST", "/v1/mail/sample", map[string]any{"on": false})
	accts, sample = stateOf(t, h)
	if sample || len(accts) != 1 || accts[0]["email"] != "me@fake.test" {
		t.Fatalf("real account not back: %v", accts)
	}
	if pw, err := s.sec.Get(int64(accts[0]["id"].(float64))); err != nil || pw != "pw" {
		t.Fatalf("real password changed: %q %v", pw, err)
	}
}

// Adding a real account while the sample is on ends the sample: the account
// goes to the real store, and the screen shows it instead of made-up mail.
func TestAddAccountLeavesSample(t *testing.T) {
	srv, err := fakemail.Start("me@fake.test", "pw")
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	s := newTestService(t)
	h := s.Handler()
	do(t, h, "POST", "/v1/mail/sample", map[string]any{"on": true})
	if _, sample := stateOf(t, h); !sample {
		t.Fatal("sample did not start")
	}
	ih, ip, _ := net.SplitHostPort(srv.IMAPAddr)
	sh, sp, _ := net.SplitHostPort(srv.SMTPAddr)
	ipn, _ := strconv.Atoi(ip)
	spn, _ := strconv.Atoi(sp)
	if w := do(t, h, "POST", "/v1/mail/accounts", map[string]any{"email": "me@fake.test", "password": "pw",
		"imap_host": ih, "imap_port": ipn, "imap_tls": "none", "smtp_host": sh, "smtp_port": spn, "smtp_tls": "none"}); w.Code != 200 {
		t.Fatalf("add: %d %s", w.Code, w.Body)
	}
	accts, sample := stateOf(t, h)
	if sample || len(accts) != 1 || accts[0]["email"] != "me@fake.test" {
		t.Fatalf("after add: sample=%v accounts=%v", sample, accts)
	}
	if pw, err := s.sec.Get(int64(accts[0]["id"].(float64))); err != nil || pw != "pw" {
		t.Fatalf("password not in the real store: %q %v", pw, err)
	}
}

// CAPROCK_MAIL_DEMO=1 keeps sample mode on for the run.
func TestDemoEnvForcesSample(t *testing.T) {
	t.Setenv("CAPROCK_MAIL_DEMO", "1")
	s := New(t.TempDir(), nil)
	t.Cleanup(s.Close)
	h := s.Handler()
	if accts, sample := stateOf(t, h); !sample || len(accts) != 2 {
		t.Fatalf("demo state: sample=%v accounts=%d", sample, len(accts))
	}
	if w := do(t, h, "POST", "/v1/mail/sample", map[string]any{"on": false}); w.Code != 409 {
		t.Fatalf("demo off must be refused: %d", w.Code)
	}
	if _, err := os.Stat(filepath.Join(s.dir, "mail.db")); !os.IsNotExist(err) {
		t.Fatal("demo created the real mail.db")
	}
}

// The sample inbox carries junk the server let through: the list leaves it
// out by default, junk=only lists it, the state counts it, and notjunk brings
// one back.
func TestJunkOverHTTP(t *testing.T) {
	t.Setenv("CAPROCK_MAIL_DEMO", "1")
	s := New(t.TempDir(), nil)
	t.Cleanup(s.Close)
	h := s.Handler()
	type row struct {
		ID      int64  `json:"id"`
		Subject string `json:"subject"`
		Junk    bool   `json:"junk"`
		Score   int    `json:"junk_score"`
		Why     string `json:"junk_why"`
	}
	list := func(path string) []row {
		t.Helper()
		var rs []row
		w := do(t, h, "GET", path, nil)
		if err := json.Unmarshal(w.Body.Bytes(), &rs); err != nil {
			t.Fatalf("%s: %v %s", path, err, w.Body)
		}
		return rs
	}
	junkCount := func() int {
		var st struct {
			Counts struct{ Junk int } `json:"counts"`
		}
		_ = json.Unmarshal(do(t, h, "GET", "/v1/mail/state", nil).Body.Bytes(), &st)
		return st.Counts.Junk
	}
	deadline := time.Now().Add(10 * time.Second)
	for junkCount() < 4 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if n := junkCount(); n != 4 {
		t.Fatalf("junk count %d, want 4", n)
	}
	for _, r := range list("/v1/mail/messages?view=inbox") {
		if r.Junk {
			t.Fatalf("junk in the default inbox: %+v", r)
		}
		if r.Subject == "Hacker Newsletter #712" && r.Score >= 50 {
			t.Fatalf("newsletter scored as junk: %+v", r)
		}
	}
	only := list("/v1/mail/messages?view=inbox&junk=only")
	if len(only) != 4 || !only[0].Junk || only[0].Why == "" {
		t.Fatalf("junk=only: %+v", only)
	}
	if n := len(list("/v1/mail/messages?view=inbox&junk=include")); n != len(list("/v1/mail/messages?view=inbox"))+4 {
		t.Fatalf("junk=include lists %d", n)
	}
	if w := do(t, h, "POST", "/v1/mail/actions", map[string]any{"ids": []int64{only[0].ID}, "action": "notjunk"}); w.Code != 200 {
		t.Fatalf("notjunk: %d %s", w.Code, w.Body)
	}
	if n := junkCount(); n != 3 {
		t.Fatalf("after notjunk: %d", n)
	}
}
