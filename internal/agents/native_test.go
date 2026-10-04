package agents

import (
	"reflect"
	"testing"
)

func TestNativeResume(t *testing.T) {
	const id = "0b6f2c1e-1111-4a2b-9c3d-123456789abc"
	cases := []struct {
		agent string
		fork  bool
		want  []string
	}{
		{"claude", false, []string{"claude", "--resume", id}},
		{"", false, []string{"claude", "--resume", id}},
		{"claude", true, []string{"claude", "--resume", id, "--fork-session"}},
		{"codex", false, []string{"codex", "resume", id}},
		{"opencode", false, []string{"opencode", "--session", id}},
		// No fork that does not double the cost, no resume by id.
		{"codex", true, nil},
		{"opencode", true, nil},
		{"gemini", false, nil},
		{"deepseek", false, nil},
	}
	for _, c := range cases {
		got, err := NativeResume(c.agent, id, c.fork)
		if c.want == nil {
			if err == nil {
				t.Errorf("%s fork=%v: want refusal, got %q", c.agent, c.fork, got)
			}
			continue
		}
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s fork=%v: %q, %v", c.agent, c.fork, got, err)
		}
	}
	for _, bad := range []string{"", "-p", "a b", "x';id;'", "$(id)", "../x"} {
		if _, err := NativeResume("claude", bad, false); err == nil {
			t.Errorf("id %q accepted", bad)
		}
	}
	if _, err := NativeResume("opencode", "ses_2b1c9f0aeffeABCdef", false); err != nil {
		t.Errorf("opencode id refused: %v", err)
	}
}
