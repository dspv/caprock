package agents

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

func TestSpawnSubagentModelReachesEnvAndSession(t *testing.T) {
	for _, tc := range []struct{ choice, want string }{{"", ""}, {"haiku", "haiku"}, {"sonnet", "sonnet"}, {"opus", "opus"}, {"bogus", ""}} {
		m, st, f := newMgr(t)
		ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), SubagentModel: tc.choice})
		if err != nil {
			t.Fatal(err)
		}
		got := ""
		for _, kv := range f.lastSpec.Env {
			if v, ok := strings.CutPrefix(kv, SubagentModelEnv+"="); ok {
				got = v
			}
		}
		if got != tc.want {
			t.Errorf("choice %q: env = %q, want %q", tc.choice, got, tc.want)
		}
		sess, err := store.GetSession(context.Background(), st.DB(), ag.SessionID)
		if err != nil || sess.SubagentModel != tc.want {
			t.Errorf("choice %q: session subagent_model = %q (%v), want %q", tc.choice, sess.SubagentModel, err, tc.want)
		}
		m.Shutdown()
	}
}

func TestWithSubagentModel(t *testing.T) {
	base := []string{"A=1", SubagentModelEnv + "=old"}
	for _, m := range SubagentModels {
		got := withSubagentModel(base, AgentClaude, m)
		if !slices.Contains(got, SubagentModelEnv+"="+m) || slices.Contains(got, SubagentModelEnv+"=old") {
			t.Errorf("%s: env = %v", m, got)
		}
	}
	// Same as the session: the user's environment is left alone.
	if got := withSubagentModel(base, AgentClaude, ""); !slices.Equal(got, base) {
		t.Errorf("empty choice changed env: %v", got)
	}
	// Not on the allowlist, or not Claude Code: nothing is set.
	for _, c := range []struct{ agent, m string }{{AgentClaude, "gpt-5"}, {AgentClaude, "haiku; rm"}, {AgentCodex, "haiku"}} {
		if got := withSubagentModel(base, c.agent, c.m); !slices.Equal(got, base) {
			t.Errorf("%v changed env: %v", c, got)
		}
	}
	if ValidSubagentModel("Haiku") || !ValidSubagentModel("") || !ValidSubagentModel("opus") {
		t.Error("allowlist is exactly empty, haiku, sonnet, opus")
	}
}
