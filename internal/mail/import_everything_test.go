package mail

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type scanAnswer struct {
	Accounts []struct {
		Email    string   `json:"email"`
		Provider string   `json:"provider"`
		Source   string   `json:"source"`
		From     []string `json:"from"`
		Signin   string   `json:"signin"`
		LastUsed int64    `json:"last_used"`
	} `json:"accounts"`
	Sources []struct {
		Kind     string `json:"kind"`
		LastUsed int64  `json:"last_used"`
	} `json:"sources"`
	OAuth map[string]bool `json:"oauth"`
}

func scan(t *testing.T, s *Service) scanAnswer {
	t.Helper()
	w := do(t, s.Handler(), "GET", "/v1/mail/import", nil)
	if w.Code != 200 {
		t.Fatalf("scan: %d %s", w.Code, w.Body)
	}
	var out scanAnswer
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// The merged list says what each account still needs, and a provider this
// build cannot sign in with falls back to an app password, never a dead
// button.
func TestImportScanSaysTheOneStepEachAccountNeeds(t *testing.T) {
	cases := []struct{ email, host, unconfigured, configured string }{
		{"me@gmail.com", "imap.gmail.com", "app_password", "oauth"},
		{"me@outlook.com", "outlook.office365.com", "app_password", "oauth"},
		{"me@icloud.com", "imap.mail.me.com", "app_password", "app_password"},
		{"me@example.org", "mail.example.org", "password", "password"},
	}
	for _, c := range cases {
		for _, configured := range []bool{false, true} {
			id := ""
			if configured {
				id = "client"
			}
			t.Setenv("CAPROCK_MAIL_GOOGLE_CLIENT_ID", id)
			t.Setenv("CAPROCK_MAIL_MICROSOFT_CLIENT_ID", id)
			s := newTestService(t)
			s.home = tbFixtureHome(t, c.email, c.host, 993, "smtp."+c.host, 587)
			got := scan(t, s)
			if len(got.Accounts) != 1 {
				t.Fatalf("%s: want one account, got %+v", c.email, got.Accounts)
			}
			want := c.unconfigured
			if configured {
				want = c.configured
			}
			a := got.Accounts[0]
			if a.Signin != want || a.Source != "thunderbird" || len(a.From) != 1 {
				t.Errorf("%s (client id %v): signin %q from %s, want %q", c.email, configured, a.Signin, a.Source, want)
			}
			if got.OAuth["google"] != configured || got.OAuth["microsoft"] != configured {
				t.Errorf("oauth availability: %v", got.OAuth)
			}
			if s.opened() {
				t.Fatal("scanning opened Mail")
			}
		}
	}
}

// Where each account was found: the profile's last write, so the screen can
// name it and leave a long-unused one unticked.
func TestImportScanSaysWhenTheProfileWasLastUsed(t *testing.T) {
	s := newTestService(t)
	s.home = tbFixtureHome(t, "me@example.org", "mail.example.org", 993, "smtp.example.org", 587)
	var prefs string
	_ = filepath.WalkDir(s.home, func(p string, d os.DirEntry, _ error) error {
		if d != nil && d.Name() == "prefs.js" {
			prefs = p
		}
		return nil
	})
	when := time.Date(2025, 3, 12, 10, 0, 0, 0, time.UTC)
	if err := os.Chtimes(prefs, when, when); err != nil {
		t.Fatal(err)
	}
	got := scan(t, s)
	if len(got.Accounts) != 1 || got.Accounts[0].LastUsed != when.UnixMilli() {
		t.Fatalf("account last_used: %+v", got.Accounts)
	}
	if len(got.Sources) != 1 || got.Sources[0].LastUsed != when.UnixMilli() {
		t.Fatalf("source last_used: %+v", got.Sources)
	}
}

type flowAnswer struct {
	Status string `json:"status"`
	Email  string `json:"email"`
	Error  string `json:"error"`
}

func flowStatus(t *testing.T, s *Service, id string) flowAnswer {
	t.Helper()
	w := do(t, s.Handler(), "GET", "/v1/mail/oauth/flow?id="+url.QueryEscape(id), nil)
	var out flowAnswer
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil {
		t.Fatalf("flow: %d %s", w.Code, w.Body)
	}
	return out
}

func startHint(t *testing.T, s *Service, provider, hint string) (authURL, flow string) {
	t.Helper()
	r := httptest.NewRequest("POST", "/v1/mail/oauth/start", strings.NewReader(`{"provider":"`+provider+`","login_hint":"`+hint+`"}`))
	r.Host = "127.0.0.1:22776"
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	var out struct {
		AuthURL string `json:"auth_url"`
		Flow    string `json:"flow"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || out.Flow == "" {
		t.Fatalf("start: %d %s", w.Code, w.Body)
	}
	return out.AuthURL, out.Flow
}

// The import screen follows one sign-in by its flow id: pending while the
// browser is out, then ok with the address, or the reason it failed.
func TestOAuthFlowStatusFollowsOneSignIn(t *testing.T) {
	s, prov, _ := oauthFixture(t)
	authURL, flow := startHint(t, s, "google", "me@fake.test")
	if u, _ := url.Parse(authURL); u.Query().Get("login_hint") != "me@fake.test" {
		t.Fatalf("login_hint missing: %s", authURL)
	}
	if strings.Contains(authURL, flow) {
		t.Fatal("the flow id must not be the state")
	}
	if got := flowStatus(t, s, flow); got.Status != "pending" {
		t.Fatalf("before the browser: %+v", got)
	}
	redirect, err := prov.Approve(authURL)
	if err != nil {
		t.Fatal(err)
	}
	if w := callback(s.Handler(), redirect); w.Code != 200 {
		t.Fatalf("callback: %d %s", w.Code, w.Body)
	}
	if got := flowStatus(t, s, flow); got.Status != "ok" || got.Email != "me@fake.test" {
		t.Fatalf("after: %+v", got)
	}

	// Refused at the provider: the reason comes back.
	authURL, flow = startHint(t, s, "google", "")
	if u, _ := url.Parse(authURL); u.Query().Has("login_hint") {
		t.Fatalf("no hint, no login_hint: %s", authURL)
	}
	u, _ := url.Parse(authURL)
	w := callback(s.Handler(), "http://127.0.0.1:22776/v1/mail/oauth/callback?error=access_denied&error_description=The+user+said+no&state="+u.Query().Get("state"))
	if w.Code != 400 {
		t.Fatalf("denied callback: %d", w.Code)
	}
	if got := flowStatus(t, s, flow); got.Status != "error" || !strings.Contains(got.Error, "The user said no") {
		t.Fatalf("denied: %+v", got)
	}

	if got := flowStatus(t, s, "nope"); got.Status != "expired" || got.Error == "" {
		t.Fatalf("unknown: %+v", got)
	}
}
