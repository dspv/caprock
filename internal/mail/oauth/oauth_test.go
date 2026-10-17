package oauth_test

import (
	"context"
	"encoding/base64"
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/mail/oauth"
	"github.com/dspv/caprock/internal/mail/oauth/oauthtest"
)

func TestUnconfiguredProviderIsUnavailable(t *testing.T) {
	t.Setenv("CAPROCK_MAIL_GOOGLE_CLIENT_ID", "")
	t.Setenv("CAPROCK_MAIL_MICROSOFT_CLIENT_ID", "")
	if got := oauth.Available(); got["google"] || got["microsoft"] {
		t.Fatalf("available with no client IDs: %v", got)
	}
	t.Setenv("CAPROCK_MAIL_MICROSOFT_CLIENT_ID", "ms-id")
	if got := oauth.Available(); got["google"] || !got["microsoft"] {
		t.Fatalf("env client ID not picked up: %v", got)
	}
	old := oauth.GoogleClientID
	oauth.GoogleClientID = "built-in"
	t.Cleanup(func() { oauth.GoogleClientID = old })
	if p, _ := oauth.Lookup("google"); p.ClientID != "built-in" {
		t.Fatalf("ldflags client ID not used: %q", p.ClientID)
	}
}

func TestAuthCodeURL(t *testing.T) {
	p, _ := oauth.Lookup("google")
	p.ClientID = "cid"
	u, err := url.Parse(p.AuthCodeURL("st", "verifier-verifier-verifier-verifier-verifier", p.RedirectURI("22776")))
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	want := map[string]string{
		"client_id": "cid", "response_type": "code", "state": "st", "code_challenge_method": "S256",
		"access_type": "offline", "prompt": "consent",
		"redirect_uri": "http://127.0.0.1:22776/v1/mail/oauth/callback",
		"scope":        "https://mail.google.com/ openid email",
	}
	for k, v := range want {
		if q.Get(k) != v {
			t.Errorf("%s = %q, want %q", k, q.Get(k), v)
		}
	}
	if q.Get("code_challenge") != oauth.Challenge("verifier-verifier-verifier-verifier-verifier") {
		t.Error("challenge is not S256 of the verifier")
	}
	ms, _ := oauth.Lookup("microsoft")
	if got := ms.RedirectURI("1234"); got != "http://localhost:1234/v1/mail/oauth/callback" {
		t.Errorf("microsoft redirect = %q", got)
	}
}

// RFC 7636 appendix B's example.
func TestChallengeS256(t *testing.T) {
	if got := oauth.Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"); got != "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" {
		t.Fatalf("challenge = %s", got)
	}
}

func TestExchangeChecksPKCEAndReadsEmail(t *testing.T) {
	srv := oauthtest.Start(t, &oauth.Google, "ana@gmail.example")
	p, _ := oauth.Lookup("google")
	redirect := p.RedirectURI("5000")
	back, err := srv.Approve(p.AuthCodeURL("s", "right-verifier-right-verifier-right-verifier", redirect))
	if err != nil {
		t.Fatal(err)
	}
	code := mustQuery(t, back, "code")
	// A wrong verifier is refused: whoever saw the code cannot use it.
	if _, err := p.Exchange(context.Background(), code, "wrong-verifier-wrong-verifier-wrong-verifier", redirect); err == nil {
		t.Fatal("wrong PKCE verifier accepted")
	}
	back, _ = srv.Approve(p.AuthCodeURL("s", "right-verifier-right-verifier-right-verifier", redirect))
	tok, err := p.Exchange(context.Background(), mustQuery(t, back, "code"), "right-verifier-right-verifier-right-verifier", redirect)
	if err != nil {
		t.Fatal(err)
	}
	if tok.AccessToken == "" || tok.RefreshToken == "" {
		t.Fatalf("token = %+v", tok)
	}
	email, err := oauth.EmailFromIDToken(tok.IDToken)
	if err != nil || email != "ana@gmail.example" {
		t.Fatalf("email = %q, %v", email, err)
	}
}

func TestEmailFromIDTokenMicrosoftClaims(t *testing.T) {
	enc := base64.RawURLEncoding.EncodeToString
	tok := enc([]byte(`{}`)) + "." + enc([]byte(`{"preferred_username":"bo@outlook.example","name":"Bo"}`)) + ".x"
	if got, err := oauth.EmailFromIDToken(tok); err != nil || got != "bo@outlook.example" {
		t.Fatalf("preferred_username: %q %v", got, err)
	}
	tok = enc([]byte(`{}`)) + "." + enc([]byte(`{"preferred_username":"+15550100"}`)) + ".x"
	if _, err := oauth.EmailFromIDToken(tok); err == nil {
		t.Fatal("a phone number read as an address")
	}
	if _, err := oauth.EmailFromIDToken(""); err == nil {
		t.Fatal("empty ID token accepted")
	}
}

func TestAccessTokenCachesAndRefreshes(t *testing.T) {
	srv := oauthtest.Start(t, &oauth.Microsoft, "bo@outlook.example")
	ctx := context.Background()
	a1, keep, err := oauth.AccessToken(ctx, "microsoft", "refresh-1")
	if err != nil || keep != "refresh-1" || a1 == "" {
		t.Fatalf("first: %q %q %v", a1, keep, err)
	}
	a2, _, _ := oauth.AccessToken(ctx, "microsoft", "refresh-1")
	if a2 != a1 || srv.Refreshes() != 1 {
		t.Fatalf("not cached: %q vs %q, %d refreshes", a2, a1, srv.Refreshes())
	}
	oauth.Forget("refresh-1")
	if a3, _, _ := oauth.AccessToken(ctx, "microsoft", "refresh-1"); a3 == a1 || srv.Refreshes() != 2 {
		t.Fatalf("Forget did not force a refresh")
	}
	srv.Revoke()
	oauth.Forget("refresh-1")
	_, _, err = oauth.AccessToken(ctx, "microsoft", "refresh-1")
	if !errors.Is(err, oauth.ErrSignInAgain) || !strings.Contains(err.Error(), "Microsoft") {
		t.Fatalf("revoked refresh token: %v", err)
	}
}

// Revoke takes the grant back at Google (a second time is still "revoked":
// the token is dead either way); a provider with no endpoint sends nothing;
// an endpoint that fails is an error.
func TestRevoke(t *testing.T) {
	srv := oauthtest.Start(t, &oauth.Google, "me@gmail.example")
	ctx := context.Background()
	p, _ := oauth.Lookup("google")
	if ok, err := p.Revoke(ctx, "refresh-1"); !ok || err != nil || srv.Revocations() != 1 {
		t.Fatalf("revoke: %v %v (%d)", ok, err, srv.Revocations())
	}
	if _, _, err := oauth.AccessToken(ctx, "google", "refresh-1"); !errors.Is(err, oauth.ErrSignInAgain) {
		t.Fatalf("a revoked refresh token still refreshes: %v", err)
	}
	if ok, err := p.Revoke(ctx, "refresh-1"); !ok || err != nil {
		t.Fatalf("second revoke: %v %v", ok, err)
	}
	m, _ := oauth.Lookup("microsoft")
	if ok, err := m.Revoke(ctx, "refresh-1"); ok || err != nil {
		t.Fatalf("microsoft revoke: %v %v", ok, err)
	}
	p.RevokeURL = srv.URL + "/missing"
	if ok, err := p.Revoke(ctx, "refresh-1"); ok || err == nil {
		t.Fatalf("failing endpoint: %v %v", ok, err)
	}
}

func TestXOAuth2Format(t *testing.T) {
	mech, ir, err := oauth.XOAuth2("me@x.example", "tok").Start()
	if err != nil || mech != "XOAUTH2" || string(ir) != "user=me@x.example\x01auth=Bearer tok\x01\x01" {
		t.Fatalf("%s %q %v", mech, ir, err)
	}
	u, tok, err := oauth.ParseXOAuth2(ir)
	if err != nil || u != "me@x.example" || tok != "tok" {
		t.Fatalf("parse: %q %q %v", u, tok, err)
	}
}

func mustQuery(t *testing.T, raw, key string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Query().Get(key)
}
