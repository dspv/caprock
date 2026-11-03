package agents

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/subs"
)

const testKimiKey = "sk-kimi-" + "test-value-5e6f"

// A Claude Code session on Kimi has Moonshot's published set in its
// environment, the key there and nowhere else, and nothing of DeepSeek's.
func TestSpawnOnKimi(t *testing.T) {
	trustTestHome(t)
	m, _, f := newMgr(t)
	t.Cleanup(m.Shutdown)
	cwd := t.TempDir()
	ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Subscription: subs.KimiID, KimiKey: testKimiKey})
	if err != nil {
		t.Fatal(err)
	}
	for _, kv := range []string{
		"ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic",
		"ANTHROPIC_AUTH_TOKEN=" + testKimiKey,
		"ANTHROPIC_MODEL=kimi-k3[1m]",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL=kimi-k2.7-code",
		"CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000",
	} {
		if !slices.Contains(f.lastSpec.Env, kv) {
			t.Errorf("missing %s", strings.SplitN(kv, "=", 2)[0])
		}
	}
	for _, kv := range f.lastSpec.Env {
		if strings.HasPrefix(kv, "CLAUDE_CODE_EFFORT_LEVEL=") || strings.Contains(kv, DeepSeekBaseURL) {
			t.Errorf("unexpected %s", kv)
		}
	}
	if strings.Contains(ag.Command, testKimiKey) || slices.ContainsFunc(f.lastSpec.Args, func(a string) bool { return strings.Contains(a, testKimiKey) }) {
		t.Fatal("the key is on the command line")
	}
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Subscription: subs.KimiID}); err == nil {
		t.Error("a Kimi session started with no key")
	}
}
