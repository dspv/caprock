package mail

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/mail/fakemail"
	store "github.com/dspv/caprock/internal/mail/mailstore"
	"github.com/dspv/caprock/internal/mail/oauth"
	"github.com/dspv/caprock/internal/mail/oauth/oauthtest"
	"github.com/dspv/caprock/internal/mail/secrets"
)

// waitInbox polls the inbox until a message with subject arrives and returns
// its id.
func waitInbox(t *testing.T, s *Service, subject string) int64 {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		w := do(t, s.Handler(), "GET", "/v1/mail/messages?view=inbox", nil)
		var ms []struct {
			ID      int64  `json:"id"`
			Subject string `json:"subject"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &ms)
		for _, m := range ms {
			if m.Subject == subject {
				return m.ID
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("%q never synced: %s", subject, w.Body)
		}
		time.Sleep(30 * time.Millisecond)
	}
}

// The whole life of a Google account, as docs/mail-oauth.md's real-account
// test walks it, against a fake provider and a fake Gmail: sign in, sync,
// read, send, keep working once the access token has expired (a refresh
// grant, never a new sign-in), and remove — which revokes the grant at the
// provider and leaves no token behind.
func TestOAuthAccountLifecycle(t *testing.T) {
	s, prov, srv := oauthFixture(t)
	// The hour shortened: a token is due for refresh one second after it is
	// issued (the cache refreshes a minute before expiry).
	prov.ExpiresIn = 61
	srv.SetToken("")
	srv.SetTokenCheck(prov.Valid) // the server takes any live token, like Gmail
	_ = srv.Deliver("INBOX", fakemail.Msg{From: "ana@example.com", To: "me@fake.test", Subject: "hello", Body: "first body"}.Raw())
	h := s.Handler()

	// Add.
	_, authURL := start(t, h, "google")
	redirect, err := prov.Approve(authURL)
	if err != nil {
		t.Fatal(err)
	}
	if w := callback(h, redirect); w.Code != 200 {
		t.Fatalf("callback: %d %s", w.Code, w.Body)
	}
	st, _, _ := s.parts(context.Background())
	accts, _ := st.Accounts(context.Background())
	if len(accts) != 1 {
		t.Fatalf("accounts = %+v", accts)
	}
	id := accts[0].ID

	// Sync and read.
	msg := waitInbox(t, s, "hello")
	if w := do(t, h, "GET", "/v1/mail/messages/"+strconv.FormatInt(msg, 10), nil); w.Code != 200 || !strings.Contains(w.Body.String(), "first body") {
		t.Fatalf("read: %d %s", w.Code, w.Body)
	}

	// An "hour" later the access token has expired: sending refreshes it.
	time.Sleep(1100 * time.Millisecond)
	before := prov.Refreshes()
	w := do(t, h, "POST", "/v1/mail/send", map[string]any{
		"account_id": id, "to": []map[string]string{{"addr": "ana@example.com"}},
		"subject": "re: hello", "text": "sent with a refreshed token",
	})
	if w.Code != 200 || srv.SentCount() != 1 {
		t.Fatalf("send: %d %s (sent %d)", w.Code, w.Body, srv.SentCount())
	}
	if prov.Refreshes() <= before {
		t.Fatalf("refreshes %d -> %d: the expired token was not refreshed", before, prov.Refreshes())
	}
	if !strings.Contains(string(srv.Sent[0]), "sent with a refreshed token") {
		t.Fatalf("sent: %s", srv.Sent[0])
	}

	// Sync keeps working past expiry too.
	time.Sleep(1100 * time.Millisecond)
	_ = srv.Deliver("INBOX", fakemail.Msg{From: "ana@example.com", To: "me@fake.test", Subject: "later", Body: "b"}.Raw())
	do(t, h, "POST", "/v1/mail/sync?account="+strconv.FormatInt(id, 10), nil)
	waitInbox(t, s, "later")
	if sec, _ := s.sec.Get(id); sec != "refresh-1" {
		t.Fatalf("stored secret = %q, want the refresh token, never an access token", sec)
	}

	// Remove: revoked at the provider, gone from the secret store.
	w = do(t, h, "DELETE", "/v1/mail/accounts/"+strconv.FormatInt(id, 10), nil)
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"ok":true,"revoked":true}` {
		t.Fatalf("delete: %d %s", w.Code, w.Body)
	}
	if prov.Revocations() != 1 {
		t.Fatalf("revocations = %d", prov.Revocations())
	}
	if _, err := s.sec.Get(id); err != secrets.ErrNotFound {
		t.Fatalf("refresh token still stored: %v", err)
	}
	if prov.Valid(oauthtest.AccessToken(prov.Issued())) {
		t.Fatal("the last access token still works after removal")
	}
}

// Microsoft offers apps no revocation endpoint: removing the account deletes
// the refresh token here, sends nothing, and says it was not revoked there.
func TestRemoveMicrosoftAccountDoesNotCallOut(t *testing.T) {
	prov := oauthtest.Start(t, &oauth.Microsoft, "me@fake.test")
	if oauth.Microsoft.RevokeURL != "" {
		t.Fatal("Microsoft has a revocation URL")
	}
	s := newTestService(t)
	st, _, err := s.parts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// Never started: removal reads only the store and the secret.
	a := store.Account{Email: "me@fake.test", Username: "me@fake.test", IMAPHost: "127.0.0.1", IMAPPort: 1, IMAPTLS: "none", SMTPHost: "127.0.0.1", SMTPPort: 1, SMTPTLS: "none"}
	id, err := st.AddAccount(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	_ = st.SetAuth(context.Background(), id, "oauth2:microsoft")
	_ = s.sec.Set(id, "refresh-1")
	w := do(t, s.Handler(), "DELETE", "/v1/mail/accounts/"+strconv.FormatInt(id, 10), nil)
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"ok":true,"revoked":false}` {
		t.Fatalf("delete: %d %s", w.Code, w.Body)
	}
	if prov.Revocations() != 0 {
		t.Fatal("a revocation was sent")
	}
	if _, err := s.sec.Get(id); err != secrets.ErrNotFound {
		t.Fatalf("refresh token still stored: %v", err)
	}
}
