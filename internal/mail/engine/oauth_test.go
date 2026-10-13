package engine

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/mail/oauth"
	"github.com/dspv/caprock/internal/mail/oauth/oauthtest"
	"github.com/dspv/caprock/internal/mail/secrets"
)

// An OAuth account signs in to IMAP and SMTP with XOAUTH2; a token the
// servers refuse says to sign in again.
func TestXOAuth2SignIn(t *testing.T) {
	h := newHarness(t)
	h.srv.SetToken("good-token")
	a := h.acc
	a.Auth = "oauth2:google"
	got, err := TestAccount(a, "good-token")
	if err != nil {
		t.Fatal(err)
	}
	if got.Username != "me@fake.test" {
		t.Fatalf("username = %q", got.Username)
	}
	if err := sendSMTP(a, "good-token", []string{"x@example.com"}, []byte("Subject: hi\r\n\r\nhi\r\n")); err != nil {
		t.Fatal(err)
	}
	_, err = TestAccount(a, "stale-token")
	if !errors.Is(err, oauth.ErrSignInAgain) || !strings.Contains(err.Error(), "IMAP") || !strings.Contains(err.Error(), "Google") {
		t.Fatalf("refused IMAP token: %v", err)
	}
	if err := sendSMTP(a, "stale-token", []string{"x@example.com"}, []byte("Subject: hi\r\n\r\nhi\r\n")); !errors.Is(err, oauth.ErrSignInAgain) {
		t.Fatalf("refused SMTP token: %v", err)
	}
	// The password path is untouched: LOGIN still works on the same server.
	if _, err := TestAccount(h.acc, "pw"); err != nil {
		t.Fatalf("password account: %v", err)
	}
}

// The worker refreshes the stored refresh token into an access token, syncs
// with it, and a revoked sign-in lands in last_error as "sign in again".
func TestOAuthWorkerRefreshesAndReportsRevocation(t *testing.T) {
	prov := oauthtest.Start(t, &oauth.Google, "me@fake.test")
	h := newHarness(t)
	h.srv.SetToken(oauthtest.AccessToken(1)) // the first token the provider will issue
	ctx := context.Background()
	if err := h.st.SetAuth(ctx, h.acc.ID, "oauth2:google"); err != nil {
		t.Fatal(err)
	}
	sec := &secrets.Memory{}
	_ = sec.Set(h.acc.ID, "refresh-1")
	e := New(h.st, sec, nil)
	t.Cleanup(e.Stop)
	if err := e.Start(); err != nil {
		t.Fatal(err)
	}
	h.waitFor("first sync", func() bool {
		acc, _ := h.st.Account(ctx, h.acc.ID)
		return acc.LastSync > 0 && acc.LastError == ""
	})
	if prov.Refreshes() != 1 {
		t.Fatalf("refreshes = %d, want 1 (the access token is cached)", prov.Refreshes())
	}
	// Revoked at the provider and the cached token refused by the server.
	prov.Revoke()
	h.srv.SetToken("something-else")
	e.StopAccount(h.acc.ID)
	e.StartAccount(h.acc.ID)
	h.waitFor("sign-in-again error", func() bool {
		acc, _ := h.st.Account(ctx, h.acc.ID)
		return strings.Contains(acc.LastError, "sign in again") && strings.Contains(acc.LastError, "expired or was revoked")
	})
}
