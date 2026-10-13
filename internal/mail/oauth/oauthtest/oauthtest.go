// Package oauthtest is a fake OAuth provider for tests: an authorization
// step that stands in for the user's browser, and a token endpoint that
// checks PKCE, issues ID tokens and refreshes. No real network.
package oauthtest

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/dspv/caprock/internal/mail/oauth"
)

// Server is a running fake provider for one user.
type Server struct {
	*httptest.Server
	Email    string
	ClientID string

	mu        sync.Mutex
	codes     map[string]grant
	refresh   string
	revoked   bool
	issued    int // access tokens issued
	refreshes int // refresh grants answered
	// Claims replaces the ID token claims when set.
	Claims map[string]any
}

type grant struct{ challenge, redirect string }

// Start runs a provider for email, and points p (a pointer to oauth.Google or
// oauth.Microsoft) at it until the test ends.
func Start(t *testing.T, p *oauth.Provider, email string) *Server {
	t.Helper()
	s := &Server{Email: email, ClientID: "test-client", codes: map[string]grant{}, refresh: "refresh-1"}
	s.Server = httptest.NewServer(http.HandlerFunc(s.token))
	t.Cleanup(s.Close)
	old := *p
	p.TokenURL = s.URL + "/token"
	p.AuthURL = s.URL + "/auth"
	// The access token cache is process-wide and keyed by refresh token.
	oauth.Forget(s.refresh)
	t.Cleanup(func() { *p = old; oauth.Forget(s.refresh) })
	t.Setenv("CAPROCK_MAIL_GOOGLE_CLIENT_ID", s.ClientID)
	t.Setenv("CAPROCK_MAIL_MICROSOFT_CLIENT_ID", s.ClientID)
	return s
}

// AccessToken is the access token the n-th issue carries.
func AccessToken(n int) string { return fmt.Sprintf("access-%d", n) }

// Approve plays the user approving in the browser: it reads the
// authorization URL and returns the redirect the provider would send the
// browser to.
func (s *Server) Approve(authURL string) (string, error) {
	u, err := url.Parse(authURL)
	if err != nil {
		return "", err
	}
	q := u.Query()
	if q.Get("client_id") != s.ClientID || q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" {
		return "", fmt.Errorf("bad authorization request: %s", u.RawQuery)
	}
	s.mu.Lock()
	code := fmt.Sprintf("code-%d", len(s.codes)+1)
	s.codes[code] = grant{challenge: q.Get("code_challenge"), redirect: q.Get("redirect_uri")}
	s.mu.Unlock()
	back := url.Values{"code": {code}, "state": {q.Get("state")}}
	return q.Get("redirect_uri") + "?" + back.Encode(), nil
}

// Revoke makes the refresh token stop working, as when the user removes the
// app's access.
func (s *Server) Revoke() {
	s.mu.Lock()
	s.revoked = true
	s.mu.Unlock()
}

func (s *Server) idToken() string {
	claims := s.Claims
	if claims == nil {
		claims = map[string]any{"email": s.Email, "sub": "1"}
	}
	b, _ := json.Marshal(claims)
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"none"}`)) + "." + enc(b) + ".sig"
}

func (s *Server) token(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/token" || r.Method != "POST" {
		http.NotFound(w, r)
		return
	}
	_ = r.ParseForm()
	s.mu.Lock()
	defer s.mu.Unlock()
	bad := func(code, desc string) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "error_description": desc})
	}
	if r.PostForm.Get("client_id") != s.ClientID {
		bad("invalid_client", "unknown client")
		return
	}
	out := map[string]any{"token_type": "Bearer", "expires_in": 3599}
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		g, ok := s.codes[r.PostForm.Get("code")]
		delete(s.codes, r.PostForm.Get("code"))
		if !ok {
			bad("invalid_grant", "unknown or used code")
			return
		}
		if oauth.Challenge(r.PostForm.Get("code_verifier")) != g.challenge {
			bad("invalid_grant", "code_verifier does not match the code_challenge")
			return
		}
		if r.PostForm.Get("redirect_uri") != g.redirect {
			bad("invalid_grant", "redirect_uri mismatch")
			return
		}
		s.issued++
		out["access_token"] = AccessToken(s.issued)
		out["refresh_token"] = s.refresh
		out["id_token"] = s.idToken()
	case "refresh_token":
		if s.revoked || r.PostForm.Get("refresh_token") != s.refresh {
			bad("invalid_grant", "Token has been expired or revoked.")
			return
		}
		s.refreshes++
		s.issued++
		out["access_token"] = AccessToken(s.issued)
	default:
		bad("unsupported_grant_type", strings.TrimSpace(r.PostForm.Get("grant_type")))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// Refreshes is how many refresh grants were answered.
func (s *Server) Refreshes() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.refreshes
}

// Issued is how many access tokens have been issued.
func (s *Server) Issued() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.issued
}
