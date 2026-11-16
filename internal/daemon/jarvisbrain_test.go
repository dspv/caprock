package daemon

import (
	"slices"
	"testing"

	"github.com/dspv/caprock/internal/jarvisbrain"
)

// A run on a subscription gets its directory and none of the variables that
// would outrank its sign-in, as a session on it does.
func TestJarvisSubEnv(t *testing.T) {
	env := []string{"PATH=/bin", "ANTHROPIC_API_KEY=x", "CLAUDE_CONFIG_DIR=/home/me/.claude", "CODEX_API_KEY=y"}
	got := jarvisSubEnv(env, jarvisbrain.AgentClaude, "/data/profiles/ab12cd34")
	want := []string{"PATH=/bin", "CODEX_API_KEY=y", "CLAUDE_CONFIG_DIR=/data/profiles/ab12cd34"}
	if !slices.Equal(got, want) {
		t.Fatalf("claude: %v", got)
	}
	got = jarvisSubEnv(env, jarvisbrain.AgentCodex, "/data/profiles/cd34ab12")
	want = []string{"PATH=/bin", "ANTHROPIC_API_KEY=x", "CLAUDE_CONFIG_DIR=/home/me/.claude", "CODEX_HOME=/data/profiles/cd34ab12"}
	if !slices.Equal(got, want) {
		t.Fatalf("codex: %v", got)
	}
}

func TestJarvisSettingRoundTrip(t *testing.T) {
	if jarvisSettingOf(nil) != nil || jarvisConfigOf(nil) != nil {
		t.Fatal("unchosen must stay absent")
	}
	s := jarvisbrain.Setting{Agent: "codex", Sub: "ab12cd34", AutoAnswer: "off"}
	if got := jarvisSettingOf(jarvisConfigOf(&s)); *got != s {
		t.Fatalf("%+v", got)
	}
}
