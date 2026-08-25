package api

import "testing"

// The ?agent= parameter decides which money a screen shows. An unknown value
// must be an error rather than "everything": a summary rendered under a
// heading that says opencode, holding every agent's spend, is a lie the user
// has no way to detect.
func TestAgentFilterParam(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"", "", false},
		{"all", "", false},
		{"claude", "claude", false},
		{"opencode", "opencode", false},
		{"OpenCode", "", true}, // case matters; a near-miss must not silently widen
		{"gemini", "", true},
		{"'; DROP TABLE sessions--", "", true},
		{"claude,opencode", "", true},
	}
	for _, c := range cases {
		got, err := agentFilter(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("agentFilter(%q) accepted an unknown value", c.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("agentFilter(%q) = error %v", c.in, err)
			continue
		}
		if string(got) != c.want {
			t.Errorf("agentFilter(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
