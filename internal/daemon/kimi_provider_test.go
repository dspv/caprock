package daemon

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/subs"
)

const testKimiKey = "sk-kimi-" + "test-value-3c4d"

// Kimi is kept and resolved as DeepSeek is: the key in the store, never in
// config.json or GET; the daemon supplies it; a Claude model is dropped. The
// limit settings are saved beside it.
func TestKimiProvider(t *testing.T) {
	dir := t.TempDir()
	fs := &fakeSecrets{}
	d := secretsDaemon(t, dir, fs)
	a := &settingsAdapter{d: d}
	in := a.Get()
	in.KimiAPIKey = testKimiKey
	in.LimitAction, in.LimitFallbacks, in.LimitReturn = config.LimitAuto, []string{subs.KimiID}, true
	if err := a.Set(in); err != nil {
		t.Fatal(err)
	}
	if fs.get(kimiSecret.Service).v != testKimiKey {
		t.Fatal("Set did not reach the store")
	}
	if keys := configKeys(t, dir); !keys["kimi_key_stored"] || !keys["limit_action"] || !keys["limit_fallbacks"] || !keys["limit_return_after_reset"] {
		t.Fatalf("config.json keys %v", keys)
	}
	got := a.Get()
	if !got.KimiKeySet || got.KimiKeyHint == "" || got.KimiKeyWhere == nil || got.LimitAction != config.LimitAuto || !got.LimitReturn {
		t.Fatalf("GET: %+v", got)
	}
	if b, _ := json.Marshal(got); strings.Contains(string(b), testKimiKey) {
		t.Fatal("GET carries the key")
	}
	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KimiAPIKey != "" || !cfg.KimiKeyStored {
		t.Fatal("config.json holds the key")
	}

	_ = fs.get(kimiSecret.Service).Set(context.Background(), "sk-rotated-kimi-9999")
	key, err := d.kimiKey(context.Background())
	if err != nil || key != "sk-rotated-kimi-9999" {
		t.Fatalf("spawn key from store: %v", err)
	}
	sr := agents.SpawnRequest{Subscription: subs.KimiID, Model: "claude-opus-5-5"}
	if err := resolveKimi(&sr, agents.AgentClaude, key, false); err != nil || sr.KimiKey != key || sr.Model != "" {
		t.Fatalf("resolve: model %q key set %v, %v", sr.Model, sr.KimiKey != "", err)
	}
	if err := resolveKimi(&agents.SpawnRequest{}, agents.AgentCodex, key, false); err == nil {
		t.Fatal("codex resolved onto Kimi")
	}
	if err := resolveKimi(&agents.SpawnRequest{}, agents.AgentClaude, "", true); err == nil || !strings.Contains(err.Error(), "Kimi") {
		t.Fatalf("resume with no key: %v", err)
	}

	in = a.Get()
	in.KimiAPIKey = ""
	if err := a.Set(in); err != nil {
		t.Fatal(err)
	}
	if fs.get(kimiSecret.Service).v != "" || a.Get().KimiKeySet {
		t.Fatal("a removed key is still kept")
	}
}

func TestKimiListedUnderClaudeWhileAKeyIsSet(t *testing.T) {
	d := subsDaemon(t)
	a := &subsAdapter{d: d}
	find := func() *api.Subscription {
		list, err := a.List(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		for _, g := range list.Agents {
			for i, s := range g.Subscriptions {
				if s.ID == subs.KimiID {
					if g.Agent != subs.AgentClaude {
						t.Fatalf("Kimi listed under %s", g.Agent)
					}
					return &g.Subscriptions[i]
				}
			}
		}
		return nil
	}
	if find() != nil {
		t.Fatal("Kimi offered with no key")
	}
	d.opt.Config.KimiAPIKey = testKimiKey
	k := find()
	if k == nil || k.Provider != subs.KimiID || !k.SignedIn || k.Dir != "" || len(k.Windows) != 0 || k.Plan == nil || k.Plan.Kind != "metered" {
		t.Fatalf("Kimi entry: %+v", k)
	}
	sr := agents.SpawnRequest{Subscription: subs.KimiID}
	if err := d.resolveSubscription(&sr, nil); err != nil || sr.KimiKey != testKimiKey || sr.ConfigDir != "" {
		t.Fatalf("resolve: dir %q key set %v, %v", sr.ConfigDir, sr.KimiKey != "", err)
	}
	// A continued provider session runs in the added sign-in's directory its
	// conversation is under.
	prof := subs.Dir(d.opt.DataDir, "0a1b2c3d")
	sr = agents.SpawnRequest{Resume: "x"}
	prev := &store.Session{Subscription: subs.KimiID, TranscriptPath: filepath.Join(prof, "projects", "-w", "x.jsonl")}
	if err := d.resolveSubscription(&sr, prev); err != nil || sr.ConfigDir != prof {
		t.Fatalf("continued in %q, %v", sr.ConfigDir, err)
	}
}
