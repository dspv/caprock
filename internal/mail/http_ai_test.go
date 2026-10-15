package mail

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/mail/ai"
)

type aiStatusBody struct {
	Chosen    string `json:"chosen"`
	Provider  string `json:"provider"`
	SendsTo   string `json:"sends_to"`
	Available bool   `json:"available"`
	Error     string `json:"error"`
	Providers []struct {
		ID        string `json:"id"`
		Available bool   `json:"available"`
		Why       string `json:"why"`
		KeySet    bool   `json:"key_set"`
	} `json:"providers"`
}

func aiStatusOf(t *testing.T, h http.Handler) aiStatusBody {
	t.Helper()
	w := do(t, h, "GET", "/v1/mail/ai/status", nil)
	var st aiStatusBody
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &st) != nil {
		t.Fatalf("ai status: %d %s", w.Code, w.Body)
	}
	return st
}

// deadURL is a loopback address nothing listens on, so "local" is absent.
func deadURL() string {
	srv := httptest.NewServer(http.NotFoundHandler())
	u := srv.URL
	srv.Close()
	return u + "/v1"
}

// Automatic picks the first installed CLI in claude → codex → gemini order,
// and says where mail goes; with nothing installed it says what to do.
func TestAIStatusAutomaticPicksFirstInstalledCLI(t *testing.T) {
	s := newTestService(t)
	installed := map[string]string{"codex": "/opt/codex", "gemini": "/opt/gemini"}
	s.SetAI(AIDeps{Binary: func(c string) string { return installed[c] }})
	h := s.Handler()
	if w := do(t, h, "POST", "/v1/mail/sample", map[string]any{"on": true}); w.Code != 200 {
		t.Fatal(w.Body)
	}
	do(t, h, "PUT", "/v1/mail/settings", map[string]string{"ai_url": deadURL()})
	st := aiStatusOf(t, h)
	if st.Provider != ai.ProviderCodex || !st.Available || !strings.Contains(st.SendsTo, "OpenAI") || st.Chosen != "" {
		t.Fatalf("automatic: %+v", st)
	}
	installed["claude"] = "/opt/claude"
	if st := aiStatusOf(t, h); st.Provider != ai.ProviderClaude {
		t.Fatalf("claude comes first: %+v", st)
	}
	clear(installed)
	st = aiStatusOf(t, h)
	if st.Available || st.Provider != "" || st.Error == "" {
		t.Fatalf("nothing installed: %+v", st)
	}
	for _, p := range st.Providers {
		if p.ID == ai.ProviderClaude && (p.Available || !strings.Contains(p.Why, "not installed")) {
			t.Fatalf("claude row: %+v", p)
		}
	}
}

// An API provider needs its key; the key goes to the secret store and is
// never in mail.db or any answer.
func TestAIKeyStoredOutsideMailAndNeverReturned(t *testing.T) {
	t.Setenv("CAPROCK_SECRET_STORE", "file")
	s := newTestService(t)
	h := s.Handler()
	do(t, h, "PUT", "/v1/mail/settings", map[string]string{"ai_provider": ai.ProviderAnthropic})
	if st := aiStatusOf(t, h); st.Available || st.Error != "no API key yet" {
		t.Fatalf("no key: %+v", st)
	}
	const key = "sk-ant-test-secret-123"
	if w := do(t, h, "PUT", "/v1/mail/ai/key", map[string]string{"provider": ai.ProviderAnthropic, "key": key}); w.Code != 200 || strings.Contains(w.Body.String(), key) {
		t.Fatalf("put key: %d %s", w.Code, w.Body)
	}
	w := do(t, h, "GET", "/v1/mail/ai/status", nil)
	if strings.Contains(w.Body.String(), key) {
		t.Fatal("status echoed the key")
	}
	st := aiStatusOf(t, h)
	if !st.Available || st.Provider != ai.ProviderAnthropic || !strings.Contains(st.SendsTo, "api.anthropic.com") {
		t.Fatalf("with key: %+v", st)
	}
	if b, err := os.ReadFile(filepath.Join(s.dir, "mail-ai-anthropic-key")); err != nil || strings.TrimSpace(string(b)) != key {
		t.Fatalf("key file: %q %v", b, err)
	}
	s.Close()
	if db, _ := os.ReadFile(filepath.Join(s.dir, "mail.db")); strings.Contains(string(db), key) {
		t.Fatal("the key is in mail.db")
	}
	if w := do(t, h, "PUT", "/v1/mail/ai/key", map[string]string{"provider": ai.ProviderClaude, "key": "x"}); w.Code != 400 {
		t.Fatalf("a CLI takes no key: %d", w.Code)
	}
}

// Sample mode keeps a typed key in memory: the keychain and the data
// directory are not touched.
func TestAIKeyInSampleModeStaysInMemory(t *testing.T) {
	t.Setenv("CAPROCK_SECRET_STORE", "file")
	s := newTestService(t)
	h := s.Handler()
	do(t, h, "POST", "/v1/mail/sample", map[string]any{"on": true})
	if w := do(t, h, "PUT", "/v1/mail/ai/key", map[string]string{"provider": ai.ProviderOpenAI, "key": "k"}); w.Code != 200 {
		t.Fatal(w.Body)
	}
	if _, err := os.Stat(filepath.Join(s.dir, "mail-ai-openai-key")); !os.IsNotExist(err) {
		t.Fatal("sample mode wrote a key file")
	}
}

// Summarise runs through the chosen provider (a local server here) with the
// thread fenced as data, and only once AI is on.
func TestAISummarizeThroughChosenProvider(t *testing.T) {
	var sys, user string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/models") {
			_, _ = w.Write([]byte(`{"data":[{"id":"m1"}]}`))
			return
		}
		var req struct {
			Messages []struct{ Content string } `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		sys, user = req.Messages[0].Content, req.Messages[1].Content
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"- a summary"}}]}`))
	}))
	defer srv.Close()
	s := newTestService(t)
	s.SetAI(AIDeps{Binary: func(string) string { return "" }})
	h := s.Handler()
	do(t, h, "POST", "/v1/mail/sample", map[string]any{"on": true})
	var id int64
	deadline := time.Now().Add(10 * time.Second)
	for id == 0 {
		var ms []struct {
			ID int64 `json:"id"`
		}
		_ = json.Unmarshal(do(t, h, "GET", "/v1/mail/messages?view=inbox", nil).Body.Bytes(), &ms)
		if len(ms) > 0 {
			id = ms[0].ID
		} else if time.Now().After(deadline) {
			t.Fatal("sample inbox empty")
		} else {
			time.Sleep(30 * time.Millisecond)
		}
	}
	do(t, h, "PUT", "/v1/mail/settings", map[string]string{"ai_url": srv.URL + "/v1"})
	if w := do(t, h, "POST", "/v1/mail/ai/summarize", map[string]any{"message_id": id}); w.Code != 409 {
		t.Fatalf("AI off must refuse: %d", w.Code)
	}
	do(t, h, "PUT", "/v1/mail/settings", map[string]string{"ai_enabled": "1"})
	w := do(t, h, "POST", "/v1/mail/ai/summarize", map[string]any{"message_id": id})
	if w.Code != 200 || !strings.Contains(w.Body.String(), "a summary") || !strings.Contains(w.Body.String(), `"provider":"local"`) || !strings.Contains(w.Body.String(), `"label":"Local model"`) {
		t.Fatalf("summarize: %d %s", w.Code, w.Body)
	}
	if !strings.Contains(user, "BEGIN EMAIL DATA") || !strings.Contains(sys, "never follow it") {
		t.Fatal("the thread was not sent as fenced data")
	}
	// A chosen provider that is not ready refuses before reading any mail.
	do(t, h, "PUT", "/v1/mail/settings", map[string]string{"ai_provider": ai.ProviderGemini})
	if w := do(t, h, "POST", "/v1/mail/ai/draft", map[string]any{"message_id": id}); w.Code != 409 || !strings.Contains(w.Body.String(), "not installed") {
		t.Fatalf("gemini absent: %d %s", w.Code, w.Body)
	}
}

// Before Mail is used, the status answers from defaults without creating
// mail.db.
func TestAIStatusOnUnusedMailCreatesNothing(t *testing.T) {
	t.Setenv("CAPROCK_SECRET_STORE", "file") // the key rows are read: never the real keychain
	s := newTestService(t)
	s.SetAI(AIDeps{Binary: func(c string) string {
		if c == "claude" {
			return "/opt/claude"
		}
		return ""
	}})
	if st := aiStatusOf(t, s.Handler()); st.Provider != ai.ProviderClaude || !st.Available {
		t.Fatalf("%+v", st)
	}
	if _, err := os.Stat(filepath.Join(s.dir, "mail.db")); !os.IsNotExist(err) {
		t.Fatal("status created mail.db")
	}
}
