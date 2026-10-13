package mail

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/mail/fakemail"
	"github.com/dspv/caprock/internal/mail/oauth"
	"github.com/dspv/caprock/internal/mail/oauth/oauthtest"
)

// oauthFixture: a fake Google whose tokens open a fake mail server.
func oauthFixture(t *testing.T) (*Service, *oauthtest.Server, *fakemail.Server) {
	t.Helper()
	prov := oauthtest.Start(t, &oauth.Google, "me@fake.test")
	srv, err := fakemail.Start("me@fake.test", "app-password")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Close)
	srv.SetToken(oauthtest.AccessToken(1))
	ih, ip, _ := net.SplitHostPort(srv.IMAPAddr)
	sh, sp, _ := net.SplitHostPort(srv.SMTPAddr)
	oauth.Google.IMAPHost, oauth.Google.IMAPTLS = ih, "none"
	oauth.Google.IMAPPort, _ = strconv.Atoi(ip)
	oauth.Google.SMTPHost, oauth.Google.SMTPTLS = sh, "none"
	oauth.Google.SMTPPort, _ = strconv.Atoi(sp)
	return newTestService(t), prov, srv
}

// start asks for the provider's page as the dashboard on this machine does.
func start(t *testing.T, h http.Handler, provider string) (int, string) {
	t.Helper()
	r := httptest.NewRequest("POST", "/v1/mail/oauth/start", strings.NewReader(`{"provider":"`+provider+`"}`))
	r.Host = "127.0.0.1:22776"
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var out struct {
		AuthURL string `json:"auth_url"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out.AuthURL
}

func callback(h http.Handler, redirect string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", redirect, nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestOAuthProvidersReportsConfiguredOnly(t *testing.T) {
	t.Setenv("CAPROCK_MAIL_GOOGLE_CLIENT_ID", "")
	t.Setenv("CAPROCK_MAIL_MICROSOFT_CLIENT_ID", "x")
	s := newTestService(t)
	w := do(t, s.Handler(), "GET", "/v1/mail/oauth/providers", nil)
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"google":false,"microsoft":true}` {
		t.Fatalf("providers: %d %s", w.Code, w.Body)
	}
	if code, _ := start(t, s.Handler(), "google"); code != 409 {
		t.Fatalf("start with no client ID: %d", code)
	}
	code, authURL := start(t, s.Handler(), "microsoft")
	if code != 200 || !strings.Contains(authURL, "redirect_uri=http%3A%2F%2Flocalhost%3A22776%2Fv1%2Fmail%2Foauth%2Fcallback") {
		t.Fatalf("microsoft start: %d %s", code, authURL)
	}
	if s.opened() {
		t.Fatal("asking about providers opened Mail")
	}
}

// Start, approve in the "browser", come back: the account exists, signs in
// with XOAUTH2, syncs, and keeps the refresh token — never a password.
func TestOAuthStartToCallbackCreatesAccount(t *testing.T) {
	s, prov, srv := oauthFixture(t)
	_ = srv.Deliver("INBOX", fakemail.Msg{From: "ana@example.com", To: "me@fake.test", Subject: "hello", Body: "hi"}.Raw())
	h := s.Handler()
	code, authURL := start(t, h, "google")
	if code != 200 || authURL == "" {
		t.Fatalf("start: %d", code)
	}
	redirect, err := prov.Approve(authURL)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(redirect, "http://127.0.0.1:22776/v1/mail/oauth/callback?") {
		t.Fatalf("redirect = %s", redirect)
	}
	w := callback(h, redirect)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "me@fake.test is connected") {
		t.Fatalf("callback: %d %s", w.Code, w.Body)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("content type %q", ct)
	}
	st, _, _ := s.parts(context.Background())
	accts, _ := st.Accounts(context.Background())
	if len(accts) != 1 || accts[0].Auth != "oauth2:google" || accts[0].Email != "me@fake.test" {
		t.Fatalf("accounts = %+v", accts)
	}
	if sec, _ := s.sec.Get(accts[0].ID); sec != "refresh-1" {
		t.Fatalf("stored secret = %q, want the refresh token", sec)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		w := do(t, h, "GET", "/v1/mail/messages?view=inbox", nil)
		if strings.Contains(w.Body.String(), `"subject":"hello"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never synced: %s", w.Body)
		}
		time.Sleep(30 * time.Millisecond)
	}
	// The same link again is refused: a state works once.
	if w := callback(h, redirect); w.Code != 400 || !strings.Contains(w.Body.String(), "expired or was already used") {
		t.Fatalf("reused state: %d %s", w.Code, w.Body)
	}
	// A password cannot be slipped onto an OAuth account.
	if w := do(t, h, "PUT", "/v1/mail/accounts/"+strconv.FormatInt(accts[0].ID, 10), map[string]any{"email": "me@fake.test", "password": "x"}); w.Code != 400 {
		t.Fatalf("password on oauth account: %d %s", w.Code, w.Body)
	}
}

func TestOAuthCallbackRefusesUnknownAndExpiredState(t *testing.T) {
	s, prov, _ := oauthFixture(t)
	h := s.Handler()
	if w := callback(h, "http://127.0.0.1:22776/v1/mail/oauth/callback?state=made-up&code=c"); w.Code != 400 {
		t.Fatalf("unknown state: %d", w.Code)
	}
	old := flowTTL
	flowTTL = -time.Second
	t.Cleanup(func() { flowTTL = old })
	_, authURL := start(t, h, "google")
	redirect, _ := prov.Approve(authURL)
	if w := callback(h, redirect); w.Code != 400 || !strings.Contains(w.Body.String(), "expired") {
		t.Fatalf("expired state: %d %s", w.Code, w.Body)
	}
	if s.opened() {
		t.Fatal("a refused callback opened Mail")
	}
}

// The provider answering with an error (the user pressed Cancel) and a
// server that refuses the token both end on a page that says so, with
// nothing stored.
func TestOAuthCallbackErrors(t *testing.T) {
	s, prov, srv := oauthFixture(t)
	h := s.Handler()
	_, authURL := start(t, h, "google")
	redirect, _ := prov.Approve(authURL)
	denied := strings.Replace(redirect, "code=", "error=access_denied&x=", 1)
	if w := callback(h, denied); w.Code != 400 || !strings.Contains(w.Body.String(), "access_denied") {
		t.Fatalf("denied: %d %s", w.Code, w.Body)
	}
	srv.SetToken("another-token")
	_, authURL = start(t, h, "google")
	redirect, _ = prov.Approve(authURL)
	if w := callback(h, redirect); w.Code != 502 || !strings.Contains(w.Body.String(), "sign in again") {
		t.Fatalf("refused token: %d %s", w.Code, w.Body)
	}
	if s.opened() {
		t.Fatal("a failed sign-in stored something")
	}
}

// A paired phone cannot start a sign-in: the browser must come back to this
// machine's loopback.
func TestOAuthStartOnlyOnLoopback(t *testing.T) {
	s, _, _ := oauthFixture(t)
	r := httptest.NewRequest("POST", "/v1/mail/oauth/start", strings.NewReader(`{"provider":"google"}`))
	r.Host = "192.168.1.20:22776"
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("LAN start: %d %s", w.Code, w.Body)
	}
}
