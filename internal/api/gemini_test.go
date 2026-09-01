package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/gemini"
	"github.com/dspv/caprock/internal/license"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"

	"net/http/httptest"
)

// geminiEnv is a server with the Gemini dependency wired to a spy, so a test
// can tell whether a request would actually have left the machine.
type geminiEnv struct {
	srv      *httptest.Server
	settings *fakeSettings
	called   *int
}

func newGeminiEnv(t *testing.T) *geminiEnv {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tb, _ := cost.Embedded()
	b := bus.New()
	rec := rollup.New(st, tb, b, nil)
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	rec.Now = func() time.Time { return now }
	settings := &fakeSettings{}
	called := 0

	s := New(Deps{
		Store: st, Bus: b, Table: tb, Version: "test", Settings: settings,
		Now: func() time.Time { return now },
		AskGemini: func(ctx context.Context, model, prompt string) (any, error) {
			called++
			return map[string]any{"text": "ok", "model": "gemini-3.5-flash-lite"}, nil
		},
	})
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return &geminiEnv{srv: srv, settings: settings, called: &called}
}

func (e *geminiEnv) ask(t *testing.T, prompt string) int {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"prompt": prompt})
	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/v1/gemini/ask", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	return res.StatusCode
}

func (e *geminiEnv) license(t *testing.T, key string) {
	t.Helper()
	cur := e.settings.Get()
	cur.LicenseKey = key
	if err := e.settings.Set(cur); err != nil {
		t.Fatal(err)
	}
}

// The whole reason this endpoint checks the licence server-side, unlike the
// spend cap: a call here spends the user's Gemini quota and opens an outbound
// connection, so a React-only paywall would be a paywall a curl walks past.
func TestAskRequiresALicenceOnTheServer(t *testing.T) {
	t.Setenv(gemini.EnvKey, "test-key")
	e := newGeminiEnv(t)

	if code := e.ask(t, "hello"); code != http.StatusPaymentRequired {
		t.Fatalf("unlicensed ask: got %d, want 402", code)
	}
	if *e.called != 0 {
		t.Error("an unlicensed request reached Google — the gate must run before the call")
	}

	e.license(t, license.Issue(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), license.RandomSuffix))
	if code := e.ask(t, "hello"); code != http.StatusOK {
		t.Fatalf("licensed ask: got %d, want 200", code)
	}
	if *e.called != 1 {
		t.Errorf("licensed request did not reach the client (called=%d)", *e.called)
	}
}

// Without a key the answer is "not set up here", not "you did something wrong"
// and not "pay us" — the distinction is what lets the screen say which of the
// two things is missing.
func TestAskWithoutAKeySaysSoBeforeTheLicence(t *testing.T) {
	t.Setenv(gemini.EnvKey, "")
	e := newGeminiEnv(t)
	if code := e.ask(t, "hello"); code != http.StatusPreconditionFailed {
		t.Fatalf("no key: got %d, want 412", code)
	}
	if *e.called != 0 {
		t.Error("called the client with no key")
	}
}

func TestStatusNeverRevealsTheKey(t *testing.T) {
	t.Setenv(gemini.EnvKey, "super-secret-value")
	e := newGeminiEnv(t)

	res, err := http.Get(e.srv.URL + "/v1/gemini")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var raw bytes.Buffer
	_, _ = raw.ReadFrom(res.Body)

	if bytes.Contains(raw.Bytes(), []byte("super-secret-value")) {
		t.Fatalf("the status endpoint echoed the key back:\n%s", raw.String())
	}
	var out map[string]any
	_ = json.Unmarshal(raw.Bytes(), &out)
	if out["available"] != true {
		t.Errorf("available should be true with a key set: %v", out)
	}
	// It names the variable so the UI can tell the user what to set, which is
	// the one thing about the key that is safe to say.
	if out["env_var"] != gemini.EnvKey {
		t.Errorf("env_var %v", out["env_var"])
	}
}

// The key must not appear in the ordinary settings surface either — that is
// the endpoint a page on 127.0.0.1 can reach through the CSRF guard.
func TestSettingsDoNotCarryTheGeminiKey(t *testing.T) {
	t.Setenv(gemini.EnvKey, "super-secret-value")
	e := newGeminiEnv(t)
	res, err := http.Get(e.srv.URL + "/v1/settings")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var raw bytes.Buffer
	_, _ = raw.ReadFrom(res.Body)
	if bytes.Contains(raw.Bytes(), []byte("super-secret-value")) {
		t.Fatalf("GET /v1/settings leaked the Gemini key:\n%s", raw.String())
	}
}

func TestEmptyPromptIsRefusedBeforeTheNetwork(t *testing.T) {
	t.Setenv(gemini.EnvKey, "k")
	e := newGeminiEnv(t)
	e.license(t, license.Issue(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), license.RandomSuffix))
	if code := e.ask(t, ""); code != http.StatusBadRequest {
		t.Fatalf("empty prompt: got %d, want 400", code)
	}
	if *e.called != 0 {
		t.Error("an empty prompt reached the client")
	}
}
