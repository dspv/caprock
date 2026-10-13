package agents

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/subs"
)

const testDeepSeekKey = "sk-test-not-a-real-key-0000"

// DeepSeek's set replaces what the login shell exported for the same names
// and drops what would send the session elsewhere or with another credential,
// whatever case Windows spelled it in.
func TestWithDeepSeek(t *testing.T) {
	base := []string{
		"PATH=/usr/bin",
		"ANTHROPIC_BASE_URL=https://gateway.example",
		"ANTHROPIC_API_KEY=sk-ant-users-own",
		"anthropic_api_key=sk-ant-lowercase",
		"CLAUDE_CODE_USE_BEDROCK=1",
		"ANTHROPIC_MODEL=claude-opus-5",
	}
	env := withDeepSeek(base, testDeepSeekKey)
	for _, want := range []string{
		"PATH=/usr/bin",
		"ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic",
		"ANTHROPIC_AUTH_TOKEN=" + testDeepSeekKey,
		"ANTHROPIC_MODEL=deepseek-flash[1m]",
		"ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-flash[1m]",
		"ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-flash[1m]",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash",
		"CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash",
	} {
		if !slices.Contains(env, want) {
			t.Errorf("missing %s", strings.SplitN(want, "=", 2)[0])
		}
	}
	for _, kv := range env {
		k := strings.ToUpper(strings.SplitN(kv, "=", 2)[0])
		if k == "ANTHROPIC_API_KEY" || k == "CLAUDE_CODE_USE_BEDROCK" {
			t.Errorf("%s survived", k)
		}
	}
	if n := len(envWith(env, "ANTHROPIC_BASE_URL=")); n != 1 {
		t.Errorf("%d base URLs", n)
	}
	// The input is not modified: a shared login-shell slice stays as it was.
	if base[2] != "ANTHROPIC_API_KEY=sk-ant-users-own" {
		t.Error("withDeepSeek changed its input")
	}
}

// A Claude Code session on DeepSeek has the key in its environment and
// nowhere else — not on its command line — runs in the user's own
// configuration directory, and records "deepseek" as its subscription.
func TestSpawnOnDeepSeek(t *testing.T) {
	trustTestHome(t)
	m, st, f := newMgr(t)
	t.Cleanup(m.Shutdown)
	cwd := t.TempDir()
	ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Subscription: subs.DeepSeekID, DeepSeekKey: testDeepSeekKey})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(f.lastSpec.Env, "ANTHROPIC_AUTH_TOKEN="+testDeepSeekKey) {
		t.Error("the key is not in the child's environment")
	}
	if !slices.Contains(f.lastSpec.Env, "ANTHROPIC_BASE_URL="+DeepSeekBaseURL) {
		t.Error("the base URL is not in the child's environment")
	}
	for _, a := range f.lastSpec.Args {
		if strings.Contains(a, testDeepSeekKey) {
			t.Fatal("the key is on the command line")
		}
	}
	if strings.Contains(ag.Command, testDeepSeekKey) {
		t.Fatal("the key is in the recorded command")
	}
	s, err := store.GetSession(context.Background(), st.DB(), ag.SessionID)
	if err != nil || s.Subscription != subs.DeepSeekID {
		t.Errorf("session subscription %q, %v", s.Subscription, err)
	}
	if strings.Contains(s.SpawnCommand, testDeepSeekKey) {
		t.Fatal("the key is in the stored spawn command")
	}

	// No key, or an agent other than Claude Code: refused.
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Subscription: subs.DeepSeekID}); err == nil {
		t.Error("a DeepSeek session started with no key")
	}
	m.bins = map[string]string{AgentCodex: "/opt/bin/codex"}
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Agent: AgentCodex, Subscription: subs.DeepSeekID, DeepSeekKey: testDeepSeekKey}); err == nil {
		t.Error("codex was started on DeepSeek")
	}
	// A session on the user's own sign-in gets none of it.
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd}); err != nil {
		t.Fatal(err)
	}
	for _, kv := range f.lastSpec.Env {
		if strings.Contains(kv, testDeepSeekKey) || strings.HasPrefix(kv, "ANTHROPIC_BASE_URL="+DeepSeekBaseURL) {
			t.Error("a session on the own sign-in got DeepSeek's environment")
		}
	}
}

// A request body cannot carry a key: the field is not JSON.
func TestDeepSeekKeyIsNotARequestField(t *testing.T) {
	var sr SpawnRequest
	if err := json.Unmarshal([]byte(`{"subscription":"deepseek","DeepSeekKey":"x","deepseek_key":"y"}`), &sr); err != nil {
		t.Fatal(err)
	}
	if sr.DeepSeekKey != "" {
		t.Fatal("a request set the key")
	}
	if b, _ := json.Marshal(SpawnRequest{DeepSeekKey: testDeepSeekKey}); strings.Contains(string(b), testDeepSeekKey) {
		t.Fatal("the key is serialised")
	}
}
