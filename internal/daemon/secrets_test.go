package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/secret"
	"github.com/dspv/caprock/internal/subs"
)

// memSecret is a secret.Store in memory: no test touches a keychain.
type memSecret struct {
	mu sync.Mutex
	v  string
}

func (m *memSecret) Get(context.Context) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.v, nil
}

func (m *memSecret) Set(_ context.Context, v string) error {
	m.mu.Lock()
	m.v = v
	m.mu.Unlock()
	return nil
}

func (m *memSecret) Delete(context.Context) error { return m.Set(context.Background(), "") }
func (m *memSecret) Kind() string                 { return "keychain" }

// fakeSecrets hands each item its own memSecret.
type fakeSecrets struct {
	mu sync.Mutex
	m  map[string]*memSecret
}

func (f *fakeSecrets) store(it secret.Item) secret.Store { return f.get(it.Service) }

func (f *fakeSecrets) get(service string) *memSecret {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.m == nil {
		f.m = map[string]*memSecret{}
	}
	if f.m[service] == nil {
		f.m[service] = &memSecret{}
	}
	return f.m[service]
}

const (
	testBotToken = "123456:bot-token-value-xyz"
	testDSKey    = "sk-deepseek-test-value-1a2b"
)

// configKeys is config.json's top-level key names, never its values.
func configKeys(t *testing.T, dir string) map[string]bool {
	t.Helper()
	b, err := os.ReadFile(config.ConfigPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	keys := map[string]bool{}
	for k := range m {
		keys[k] = true
	}
	if strings.Contains(string(b), testBotToken) || strings.Contains(string(b), testDSKey) {
		t.Fatal("config.json holds a credential")
	}
	return keys
}

func secretsDaemon(t *testing.T, dir string, fs *fakeSecrets) *Daemon {
	t.Helper()
	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	return &Daemon{log: quietLog(), opt: Options{DataDir: dir, Config: cfg, Secrets: fs.store}}
}

// A key and a bot token an older release wrote to config.json move to the
// store at start and leave the file; the next start reads them from the store.
func TestLegacyCredentialsMoveOutOfConfig(t *testing.T) {
	dir := t.TempDir()
	legacy := map[string]any{"port": 22776, "deepseek_api_key": testDSKey, "report_bot_token": testBotToken, "report_chat_id": "777"}
	b, _ := json.Marshal(legacy)
	if err := os.WriteFile(config.ConfigPath(dir), b, 0o600); err != nil {
		t.Fatal(err)
	}
	fs := &fakeSecrets{}
	d := secretsDaemon(t, dir, fs)
	d.loadSecrets(context.Background())

	if got := fs.get(deepSeekSecret.Service).v; got != testDSKey {
		t.Fatal("the DeepSeek key did not reach the store")
	}
	if got := fs.get(telegramSecret.Service).v; got != testBotToken {
		t.Fatal("the bot token did not reach the store")
	}
	keys := configKeys(t, dir)
	if keys["deepseek_api_key"] || keys["report_bot_token"] {
		t.Fatalf("legacy keys left in config.json: %v", keys)
	}
	if !keys["deepseek_key_stored"] || !keys["report_bot_stored"] || !keys["report_chat_id"] {
		t.Fatalf("config.json keys %v", keys)
	}
	if c := d.config(); c.DeepSeekAPIKey != testDSKey || c.ReportBotToken != testBotToken {
		t.Fatal("the in-memory copies were not kept")
	}

	// Next start: nothing to move, the values come from the store.
	d2 := secretsDaemon(t, dir, fs)
	d2.loadSecrets(context.Background())
	if c := d2.config(); c.DeepSeekAPIKey != testDSKey || c.ReportBotToken != testBotToken {
		t.Fatal("a restart did not read the store")
	}
}

// A store that refuses leaves the legacy value in config.json, still used.
func TestLegacyCredentialStaysWhenTheStoreRefuses(t *testing.T) {
	dir := t.TempDir()
	b, _ := json.Marshal(map[string]any{"deepseek_api_key": testDSKey})
	if err := os.WriteFile(config.ConfigPath(dir), b, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, _ := config.Load(dir)
	ro := filepath.Join(dir, "no-such-dir", "deepseek-api-key")
	d := &Daemon{log: quietLog(), opt: Options{DataDir: dir, Config: cfg, Secrets: func(secret.Item) secret.Store { return secret.File{Path: ro} }}}
	d.loadSecrets(context.Background())
	if d.config().DeepSeekAPIKey != testDSKey {
		t.Fatal("a refused move lost the key")
	}
	raw, _ := os.ReadFile(config.ConfigPath(dir))
	if !strings.Contains(string(raw), "deepseek_api_key") {
		t.Fatal("a refused move removed the key from config.json")
	}
	if w := d.secretWhere(deepSeekSecret, true, d.config().DeepSeekKeyStored); w == nil || w.Kind != "config" {
		t.Fatalf("where %+v", w)
	}
}

// Settings writes and removes through the store; config.json never holds
// the values, and GET says where they are without them.
func TestSettingsKeepCredentialsInTheStore(t *testing.T) {
	dir := t.TempDir()
	fs := &fakeSecrets{}
	d := secretsDaemon(t, dir, fs)
	a := &settingsAdapter{d: d}
	in := a.Get()
	in.DeepSeekAPIKey, in.ReportBotToken = testDSKey, testBotToken
	if err := a.Set(in); err != nil {
		t.Fatal(err)
	}
	if fs.get(deepSeekSecret.Service).v != testDSKey || fs.get(telegramSecret.Service).v != testBotToken {
		t.Fatal("Set did not reach the store")
	}
	keys := configKeys(t, dir)
	if !keys["deepseek_key_stored"] || !keys["report_bot_stored"] {
		t.Fatalf("config.json keys %v", keys)
	}
	got := a.Get()
	if got.DeepSeekKeyWhere == nil || got.DeepSeekKeyWhere.Kind != "keychain" || got.ReportBotWhere == nil {
		t.Fatalf("where %+v %+v", got.DeepSeekKeyWhere, got.ReportBotWhere)
	}
	out, _ := json.Marshal(got)
	if strings.Contains(string(out), testDSKey) || strings.Contains(string(out), testBotToken) {
		t.Fatal("GET carries a credential")
	}

	// The key is read from the store when a session starts.
	_ = fs.get(deepSeekSecret.Service).Set(context.Background(), "sk-rotated-elsewhere-9999")
	sr := agents.SpawnRequest{Subscription: subs.DeepSeekID}
	if err := resolveDeepSeekFor(d, &sr); err != nil || sr.DeepSeekKey != "sk-rotated-elsewhere-9999" {
		t.Fatalf("spawn key from store: set %v, %v", sr.DeepSeekKey != "", err)
	}

	// Remove: deleted from the store, "stored" marks gone.
	in = a.Get()
	in.DeepSeekAPIKey, in.ReportBotToken = "", ""
	if err := a.Set(in); err != nil {
		t.Fatal(err)
	}
	if fs.get(deepSeekSecret.Service).v != "" || fs.get(telegramSecret.Service).v != "" {
		t.Fatal("Remove left the value in the store")
	}
	keys = configKeys(t, dir)
	if keys["deepseek_key_stored"] || keys["report_bot_stored"] {
		t.Fatalf("config.json keys after remove %v", keys)
	}
	if g := a.Get(); g.DeepSeekKeyWhere != nil || g.ReportBotWhere != nil || g.DeepSeekKeySet || g.ReportBotSet {
		t.Fatal("a removed credential still reported")
	}
}

func resolveDeepSeekFor(d *Daemon, sr *agents.SpawnRequest) error {
	key, err := d.deepSeekKey(context.Background())
	if err != nil {
		return err
	}
	return resolveDeepSeek(sr, agents.AgentClaude, key, false)
}

// The Telegram bridge's /token flow stores through the same path.
func TestBridgeSaveBotUsesTheStore(t *testing.T) {
	dir := t.TempDir()
	fs := &fakeSecrets{}
	d := secretsDaemon(t, dir, fs)
	h := &tgHost{d: d}
	if err := h.SaveBot(testBotToken); err != nil {
		t.Fatal(err)
	}
	if fs.get(telegramSecret.Service).v != testBotToken {
		t.Fatal("SaveBot did not reach the store")
	}
	if tok, _ := h.Bot(); tok != testBotToken {
		t.Fatal("the bridge cannot read its token back")
	}
	configKeys(t, dir)
}

// Without an injected store, the daemon test run uses the 0600 files in the
// data directory (CAPROCK_SECRET_STORE=file in TestMain).
func TestDefaultSecretStoreIsTheFileUnderTest(t *testing.T) {
	dir := t.TempDir()
	d := &Daemon{log: quietLog(), opt: Options{DataDir: dir}}
	w := secret.Locate(d.secretStore(deepSeekSecret))
	if w.Kind != "file" || w.Path != filepath.Join(dir, "deepseek-api-key") {
		t.Fatalf("where %+v", w)
	}
}
