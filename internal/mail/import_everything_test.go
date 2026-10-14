package mail

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type scanAnswer struct {
	Accounts []struct {
		Email    string   `json:"email"`
		Provider string   `json:"provider"`
		Source   string   `json:"source"`
		From     []string `json:"from"`
		Signin   string   `json:"signin"`
	} `json:"accounts"`
	OAuth          map[string]bool   `json:"oauth"`
	FullDiskAccess map[string]string `json:"full_disk_access"`
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
			if got.FullDiskAccess != nil {
				t.Errorf("no Apple Mail, no Full Disk Access guidance: %v", got.FullDiskAccess)
			}
			if s.opened() {
				t.Fatal("scanning opened Mail")
			}
		}
	}
}

func TestImportScanTellsWhatNeedsFullDiskAccess(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Full Disk Access is macOS-only")
	}
	if os.Geteuid() == 0 {
		t.Skip("root reads a 0000 file")
	}
	s := newTestService(t)
	s.home = t.TempDir()
	for _, d := range []string{"Library/Mail", "Library/Accounts"} {
		if err := os.MkdirAll(filepath.Join(s.home, d), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	db := filepath.Join(s.home, "Library", "Accounts", "Accounts4.sqlite")
	if err := os.WriteFile(db, nil, 0o000); err != nil {
		t.Fatal(err)
	}
	got := scan(t, s)
	if got.FullDiskAccess == nil || got.FullDiskAccess["name"] == "" || got.FullDiskAccess["kind"] == "" {
		t.Fatalf("want what to add under Full Disk Access, got %v", got.FullDiskAccess)
	}
	if len(got.Accounts) != 0 {
		t.Errorf("nothing readable, nothing listed: %+v", got.Accounts)
	}
}

// The Full Disk Access button opens exactly System Settings' pane, only from
// this computer.
func TestOpenPrivacyPane(t *testing.T) {
	var opened []string
	old := openSettings
	openSettings = func(u string) error { opened = append(opened, u); return nil }
	t.Cleanup(func() { openSettings = old })
	s := newTestService(t)

	post := func(host string) int {
		r := httptest.NewRequest("POST", "/v1/mail/import/privacy", strings.NewReader(`{}`))
		r.Host = host
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w.Code
	}
	if runtime.GOOS != "darwin" {
		if code := post("127.0.0.1:22776"); code != 409 || len(opened) != 0 {
			t.Fatalf("off macOS: %d, opened %v", code, opened)
		}
		return
	}
	if code := post("192.168.1.20:22776"); code != 403 || len(opened) != 0 {
		t.Fatalf("from a phone: %d, opened %v", code, opened)
	}
	if code := post("localhost:22776"); code != 200 {
		t.Fatalf("from this computer: %d", code)
	}
	if len(opened) != 1 || opened[0] != "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" {
		t.Fatalf("opened %v", opened)
	}
	openSettings = func(string) error { return errors.New("no") }
	if code := post("localhost:22776"); code != 500 {
		t.Fatalf("a failed open: %d", code)
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
