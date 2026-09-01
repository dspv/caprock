package gemini

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAskParsesAnswerAndUsage(t *testing.T) {
	t.Setenv(EnvKey, "test-key")
	var gotPath, gotKey, gotQuery string
	var gotBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotKey, gotQuery = r.URL.Path, r.Header.Get("x-goog-api-key"), r.URL.RawQuery
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{
			"candidates":[{"content":{"parts":[{"text":"hello "},{"text":"world"}]}}],
			"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":5,
				"cachedContentTokenCount":8,"thoughtsTokenCount":3,"totalTokenCount":28}
		}`))
	}))
	defer srv.Close()

	c := &Client{Base: srv.URL}
	rep, err := c.Ask(context.Background(), "gemini-3.5-flash-lite", "be brief", "hi")
	if err != nil {
		t.Fatal(err)
	}
	// Parts are concatenated: Google splits one answer across several.
	if rep.Text != "hello world" {
		t.Errorf("text %q", rep.Text)
	}
	if rep.Usage.PromptTokens != 12 || rep.Usage.OutputTokens != 5 ||
		rep.Usage.CachedTokens != 8 || rep.Usage.ThoughtsTokens != 3 {
		t.Errorf("usage %+v", rep.Usage)
	}
	if !strings.Contains(gotPath, "gemini-3.5-flash-lite:generateContent") {
		t.Errorf("path %q", gotPath)
	}
	if _, ok := gotBody["systemInstruction"]; !ok {
		t.Error("system instruction not sent")
	}

	// The key travels in a header, never the URL: anything that logs request
	// lines — a proxy, a crash dump, the daemon's own log — must not capture it.
	if gotKey != "test-key" {
		t.Errorf("key header %q", gotKey)
	}
	if strings.Contains(gotQuery, "test-key") || strings.Contains(gotPath, "test-key") {
		t.Errorf("key leaked into the URL: path=%q query=%q", gotPath, gotQuery)
	}
}

// With no key the feature does not exist. This is also the off switch: there is
// no default-on path, so nothing needs disabling.
func TestNoKeyIsNotAnError(t *testing.T) {
	t.Setenv(EnvKey, "")
	if Available("") {
		t.Error("Available() true with an empty key")
	}
	if _, err := (&Client{}).Ask(context.Background(), "", "", "hi"); !errors.Is(err, ErrNoKey) {
		t.Errorf("Ask: %v, want ErrNoKey", err)
	}
	if _, err := (&Client{}).Check(context.Background()); !errors.Is(err, ErrNoKey) {
		t.Errorf("Check: %v, want ErrNoKey", err)
	}
}

func TestKeyIsTrimmed(t *testing.T) {
	// A key pasted from a web page arrives with a newline more often than not.
	t.Setenv(EnvKey, "  padded-key\n")
	if Key("") != "padded-key" {
		t.Errorf("Key() = %q", Key(""))
	}
}

// Google reports failures as HTTP 200 with an error object as often as it uses
// a status code, so the body is what decides.
func TestApiErrorIsReported(t *testing.T) {
	t.Setenv(EnvKey, "bad")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT"}}`))
	}))
	defer srv.Close()

	_, err := (&Client{Base: srv.URL}).Ask(context.Background(), "", "", "hi")
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "API key not valid") {
		t.Errorf("error should carry Google's own words, got: %v", err)
	}
}

func TestEmptyCandidatesIsAnError(t *testing.T) {
	t.Setenv(EnvKey, "k")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"candidates":[],"usageMetadata":{}}`))
	}))
	defer srv.Close()
	if _, err := (&Client{Base: srv.URL}).Ask(context.Background(), "", "", "hi"); err == nil {
		t.Error("a reply with no candidates must not pass as an answer")
	}
}

func TestCheckListsModels(t *testing.T) {
	t.Setenv(EnvKey, "k")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"models":[{"name":"models/gemini-3.5-flash"},{"name":"models/gemini-2.5-pro"}]}`))
	}))
	defer srv.Close()
	got, err := (&Client{Base: srv.URL}).Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// The "models/" prefix is Google's wire detail, not something a reader
	// should meet on screen.
	if len(got) != 2 || got[0] != "gemini-3.5-flash" {
		t.Errorf("models %v", got)
	}
}

func TestEmptyPromptRefused(t *testing.T) {
	t.Setenv(EnvKey, "k")
	if _, err := (&Client{}).Ask(context.Background(), "", "", "   "); err == nil {
		t.Error("an empty prompt must not reach the network")
	}
}
