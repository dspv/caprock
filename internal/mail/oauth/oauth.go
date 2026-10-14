// Package oauth signs Caprock Mail into Google and Microsoft accounts the way
// an installed app should (RFC 8252): the authorization code flow with PKCE
// (RFC 7636, S256) in the user's own browser, redirected back to the daemon on
// loopback. The result is a refresh token, kept in the mail secret store like
// a password, and short-lived access tokens that sign in to IMAP and SMTP with
// SASL XOAUTH2.
//
// Nothing here talks to the network until the user clicks "Sign in with
// Google/Microsoft": the authorization code and the PKCE verifier go to that
// provider's token endpoint, and later the refresh token goes to the same
// endpoint to get a new access token (ADR-057).
//
// Client IDs are the app registrations the Caprock owner makes (docs/mail-oauth.md).
// They come from the environment, else from package variables set at build
// time with -ldflags -X; a provider without one is reported unavailable and
// nothing else changes.
package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-sasl"
)

// Build-time client IDs, set with
//
//	-X github.com/dspv/caprock/internal/mail/oauth.GoogleClientID=...
//
// Empty by default: the provider is then unavailable unless the environment
// names one (CAPROCK_MAIL_GOOGLE_CLIENT_ID and so on).
//
// Google's "client secret" for a Desktop app client is not a secret: Google
// says installed apps cannot keep one ("it is assumed that these apps cannot
// keep secrets", developers.google.com/identity/protocols/oauth2/native-app),
// yet its token endpoint still wants it for that client type.
var (
	GoogleClientID     string
	GoogleClientSecret string
	MicrosoftClientID  string
)

// Provider is one OAuth identity provider and the mail servers its tokens open.
type Provider struct {
	Name     string // "google" | "microsoft"
	Label    string // "Google", for messages
	AuthURL  string
	TokenURL string
	Scopes   []string
	Extra    map[string]string // added to the authorization URL
	// RedirectHost is the loopback name in the redirect URI. Google's desktop
	// clients accept http://127.0.0.1:<any port>/<any path>; Microsoft
	// ignores the port only for "localhost", and an http 127.0.0.1 redirect
	// cannot be registered in the Azure portal, so it gets localhost.
	RedirectHost string

	IMAPHost string
	IMAPPort int
	IMAPTLS  string
	SMTPHost string
	SMTPPort int
	SMTPTLS  string

	// Resolved per call by Lookup.
	ClientID     string
	ClientSecret string

	envID, envSecret string
	buildID          *string
	buildSecret      *string
}

// CallbackPath is where the provider sends the browser back.
const CallbackPath = "/v1/mail/oauth/callback"

// Google: endpoints and parameters from
// developers.google.com/identity/protocols/oauth2/native-app (auth
// https://accounts.google.com/o/oauth2/v2/auth, token
// https://oauth2.googleapis.com/token, loopback redirect, PKCE S256) and
// developers.google.com/identity/protocols/oauth2/web-server (access_type=
// offline, prompt=consent so a refresh token comes back on a repeat sign-in).
// IMAP and SMTP need the scope https://mail.google.com/
// (developers.google.com/workspace/gmail/imap/xoauth2-protocol).
var Google = Provider{
	Name:         "google",
	Label:        "Google",
	AuthURL:      "https://accounts.google.com/o/oauth2/v2/auth",
	TokenURL:     "https://oauth2.googleapis.com/token",
	Scopes:       []string{"https://mail.google.com/", "openid", "email"},
	Extra:        map[string]string{"access_type": "offline", "prompt": "consent"},
	RedirectHost: "127.0.0.1",
	IMAPHost:     "imap.gmail.com", IMAPPort: 993, IMAPTLS: "tls",
	SMTPHost: "smtp.gmail.com", SMTPPort: 465, SMTPTLS: "tls",
	envID: "CAPROCK_MAIL_GOOGLE_CLIENT_ID", envSecret: "CAPROCK_MAIL_GOOGLE_CLIENT_SECRET",
	buildID: &GoogleClientID, buildSecret: &GoogleClientSecret,
}

// Microsoft: the v2.0 endpoints on the "common" tenant, so both personal
// (Outlook.com) and work accounts sign in
// (learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow).
// Scopes and servers from learn.microsoft.com/exchange/client-developer/
// legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth:
// https://outlook.office.com/IMAP.AccessAsUser.All, .../SMTP.Send, and
// offline_access for a refresh token; outlook.office365.com:993 and
// smtp.office365.com:587 with STARTTLS. A public client sends no secret.
var Microsoft = Provider{
	Name:     "microsoft",
	Label:    "Microsoft",
	AuthURL:  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
	TokenURL: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
	Scopes: []string{"https://outlook.office.com/IMAP.AccessAsUser.All", "https://outlook.office.com/SMTP.Send",
		"offline_access", "openid", "email"},
	Extra:        map[string]string{"prompt": "select_account"},
	RedirectHost: "localhost",
	IMAPHost:     "outlook.office365.com", IMAPPort: 993, IMAPTLS: "tls",
	SMTPHost: "smtp.office365.com", SMTPPort: 587, SMTPTLS: "starttls",
	envID: "CAPROCK_MAIL_MICROSOFT_CLIENT_ID", buildID: &MicrosoftClientID,
}

// Names lists the providers in the order the screen offers them.
var Names = []string{"google", "microsoft"}

// AuthPrefix marks an account that signs in with OAuth: its auth is
// "oauth2:google" or "oauth2:microsoft".
const AuthPrefix = "oauth2:"

// ProviderOf returns the provider name of an account's auth value, or "" for
// a password account.
func ProviderOf(auth string) string {
	name, ok := strings.CutPrefix(auth, AuthPrefix)
	if !ok {
		return ""
	}
	return name
}

// Lookup returns a provider with its client ID resolved. ok is false for an
// unknown name; an unconfigured provider comes back with an empty ClientID.
func Lookup(name string) (Provider, bool) {
	var p Provider
	switch name {
	case "google":
		p = Google
	case "microsoft":
		p = Microsoft
	default:
		return Provider{}, false
	}
	p.ClientID = firstNonEmpty(os.Getenv(p.envID), deref(p.buildID))
	if p.envSecret != "" {
		p.ClientSecret = firstNonEmpty(os.Getenv(p.envSecret), deref(p.buildSecret))
	}
	return p, true
}

// Available reports which providers have a client ID.
func Available() map[string]bool {
	out := map[string]bool{}
	for _, n := range Names {
		p, _ := Lookup(n)
		out[n] = p.ClientID != ""
	}
	return out
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x = strings.TrimSpace(x); x != "" {
			return x
		}
	}
	return ""
}

// RedirectURI is the callback address for a daemon listening on port.
func (p Provider) RedirectURI(port string) string {
	return "http://" + p.RedirectHost + ":" + port + CallbackPath
}

// RandomString is n random bytes, base64url without padding.
func RandomString(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand does not fail on supported platforms
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// Challenge is the S256 PKCE challenge of a verifier (RFC 7636 §4.2).
func Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// AuthCodeURL is the page the user's browser opens.
func (p Provider) AuthCodeURL(state, verifier, redirect string) string {
	return p.AuthCodeURLHint(state, verifier, redirect, "")
}

// AuthCodeURLHint is AuthCodeURL starting on the account hint names, when it
// names one: login_hint is honoured by both Google and Microsoft.
func (p Provider) AuthCodeURLHint(state, verifier, redirect, hint string) string {
	q := url.Values{}
	q.Set("client_id", p.ClientID)
	q.Set("response_type", "code")
	q.Set("redirect_uri", redirect)
	q.Set("scope", strings.Join(p.Scopes, " "))
	q.Set("state", state)
	q.Set("code_challenge", Challenge(verifier))
	q.Set("code_challenge_method", "S256")
	for k, v := range p.Extra {
		q.Set(k, v)
	}
	if hint != "" && strings.Contains(hint, "@") {
		q.Set("login_hint", hint)
	}
	return p.AuthURL + "?" + q.Encode()
}

// Token is what the token endpoint answers.
type Token struct {
	AccessToken  string
	RefreshToken string
	IDToken      string
	Expiry       time.Time
}

// ErrSignInAgain means the refresh token no longer works (revoked, expired,
// password changed): only a new sign-in in the browser helps.
var ErrSignInAgain = errors.New("sign in again")

// HTTPClient is used for every token request; tests may replace it.
var HTTPClient = &http.Client{Timeout: 20 * time.Second}

// Exchange trades an authorization code for tokens.
func (p Provider) Exchange(ctx context.Context, code, verifier, redirect string) (Token, error) {
	v := url.Values{}
	v.Set("grant_type", "authorization_code")
	v.Set("code", code)
	v.Set("code_verifier", verifier)
	v.Set("redirect_uri", redirect)
	v.Set("scope", strings.Join(p.Scopes, " ")) // Microsoft wants it; Google ignores it
	return p.token(ctx, v)
}

// Refresh gets a new access token. A refresh token the provider refuses is
// ErrSignInAgain.
func (p Provider) Refresh(ctx context.Context, refresh string) (Token, error) {
	v := url.Values{}
	v.Set("grant_type", "refresh_token")
	v.Set("refresh_token", refresh)
	if p.Name == "microsoft" {
		v.Set("scope", strings.Join(p.Scopes, " "))
	}
	t, err := p.token(ctx, v)
	if err == nil && t.RefreshToken == "" {
		t.RefreshToken = refresh // Google keeps the old one
	}
	return t, err
}

type tokenResp struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Error        string `json:"error"`
	Description  string `json:"error_description"`
}

func (p Provider) token(ctx context.Context, v url.Values) (Token, error) {
	if p.ClientID == "" {
		return Token{}, fmt.Errorf("%s sign-in is not configured in this build", p.Label)
	}
	v.Set("client_id", p.ClientID)
	if p.ClientSecret != "" {
		v.Set("client_secret", p.ClientSecret)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", p.TokenURL, strings.NewReader(v.Encode()))
	if err != nil {
		return Token{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := HTTPClient.Do(req)
	if err != nil {
		return Token{}, fmt.Errorf("%s token endpoint: %w", p.Label, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var tr tokenResp
	_ = json.Unmarshal(body, &tr)
	if resp.StatusCode != 200 || tr.AccessToken == "" {
		if tr.Error == "invalid_grant" && v.Get("grant_type") == "refresh_token" {
			return Token{}, fmt.Errorf("%w with %s: the sign-in expired or was revoked (%s)", ErrSignInAgain, p.Label, firstNonEmpty(tr.Description, tr.Error))
		}
		msg := firstNonEmpty(tr.Description, tr.Error, http.StatusText(resp.StatusCode))
		return Token{}, fmt.Errorf("%s refused the sign-in: %s", p.Label, msg)
	}
	t := Token{AccessToken: tr.AccessToken, RefreshToken: tr.RefreshToken, IDToken: tr.IDToken}
	if tr.ExpiresIn <= 0 {
		tr.ExpiresIn = 3600
	}
	t.Expiry = time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second)
	return t, nil
}

// EmailFromIDToken reads the address from an ID token's claims: "email",
// else Microsoft's "preferred_username" when it is an address.
//
// The signature is not checked: the token came straight from the provider's
// token endpoint over TLS, which OpenID Connect Core 1.0 §3.1.3.7 allows in
// place of checking the signature ("the TLS server validation MAY be used to
// validate the issuer"). The address is then proven by the IMAP sign-in.
func EmailFromIDToken(idToken string) (string, error) {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return "", errors.New("no ID token in the answer")
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return "", fmt.Errorf("ID token: %w", err)
	}
	var c struct {
		Email             string `json:"email"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return "", fmt.Errorf("ID token: %w", err)
	}
	for _, e := range []string{c.Email, c.PreferredUsername} {
		if e = strings.TrimSpace(e); strings.Contains(e, "@") {
			return e, nil
		}
	}
	return "", errors.New("the ID token carries no email address")
}

// --- access token cache ---

type cached struct {
	access string
	expiry time.Time
}

var (
	refreshMu sync.Mutex
	cacheMu   sync.Mutex
	cache     = map[string]cached{} // by refresh token; memory only
)

// AccessToken returns a usable access token for a refresh token, refreshing
// when the cached one is within a minute of expiry. The second result is the
// refresh token to keep from now on (Microsoft rotates them); it equals the
// one passed in when nothing changed.
func AccessToken(ctx context.Context, provider, refresh string) (string, string, error) {
	// One refresh at a time: an account's sync and IDLE connections ask
	// together, and two refreshes would cache one token and use another.
	refreshMu.Lock()
	defer refreshMu.Unlock()
	cacheMu.Lock()
	c, ok := cache[refresh]
	cacheMu.Unlock()
	if ok && time.Until(c.expiry) > time.Minute {
		return c.access, refresh, nil
	}
	p, ok := Lookup(provider)
	if !ok {
		return "", refresh, fmt.Errorf("unknown sign-in provider %q", provider)
	}
	t, err := p.Refresh(ctx, refresh)
	if err != nil {
		return "", refresh, err
	}
	Remember(t)
	return t.AccessToken, t.RefreshToken, nil
}

// Remember caches a fresh token's access token under its refresh token.
func Remember(t Token) {
	if t.RefreshToken == "" || t.AccessToken == "" {
		return
	}
	cacheMu.Lock()
	cache[t.RefreshToken] = cached{access: t.AccessToken, expiry: t.Expiry}
	cacheMu.Unlock()
}

// Forget drops a cached access token, after a server refused it.
func Forget(refresh string) {
	cacheMu.Lock()
	delete(cache, refresh)
	cacheMu.Unlock()
}

// --- SASL XOAUTH2 ---

// XOAuth2 is the SASL XOAUTH2 client: "user=" email ^A "auth=Bearer " token
// ^A^A (developers.google.com/workspace/gmail/imap/xoauth2-protocol; the same
// format at Microsoft). On failure the server sends a JSON error as a
// challenge, which is answered with an empty response, and then refuses.
func XOAuth2(user, token string) sasl.Client { return &xoauth2{user: user, token: token} }

// XOAuth2Mech is the mechanism name.
const XOAuth2Mech = "XOAUTH2"

type xoauth2 struct{ user, token string }

func (x *xoauth2) Start() (string, []byte, error) {
	return XOAuth2Mech, []byte("user=" + x.user + "\x01auth=Bearer " + x.token + "\x01\x01"), nil
}

func (x *xoauth2) Next([]byte) ([]byte, error) { return []byte{}, nil }

// ParseXOAuth2 splits an XOAUTH2 initial response; for test servers.
func ParseXOAuth2(resp []byte) (user, token string, err error) {
	for _, f := range strings.Split(string(resp), "\x01") {
		switch {
		case strings.HasPrefix(f, "user="):
			user = f[len("user="):]
		case strings.HasPrefix(f, "auth=Bearer "):
			token = f[len("auth=Bearer "):]
		}
	}
	if user == "" || token == "" {
		return "", "", errors.New("malformed XOAUTH2 response")
	}
	return user, token, nil
}
