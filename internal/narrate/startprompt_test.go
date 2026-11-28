package narrate

import (
	"testing"
	"time"
)

// A Claude Code session Caprock started that has sent no hook 20 s after the
// start, with the hooks installed, reads as held at a prompt in its terminal
// (#1118: three sessions on a Windows PC sat at "Adding a new directory" and
// read as running). Anything else keeps what its events say.
func TestHeldAtStart(t *testing.T) {
	start := time.Date(2026, 11, 28, 10, 0, 0, 0, time.UTC)
	late := start.Add(StartPromptAfter)
	cases := []struct {
		name                            string
		agent                           string
		owned, ended, hasHooks, hooksOn bool
		events                          int
		now                             time.Time
		want                            bool
	}{
		{"owned, no hook after 20 s", "", true, false, false, true, 0, late, true},
		{"claude by name", "claude", true, false, false, true, 0, late.Add(time.Hour), true},
		{"still starting", "", true, false, false, true, 0, start.Add(StartPromptAfter - time.Second), false},
		{"its first hook came", "", true, false, true, true, 0, late, false},
		{"an event of any kind", "", true, false, false, true, 1, late, false},
		{"hooks not installed: silence is by design", "", true, false, false, false, 0, late, false},
		{"started in another terminal", "", false, false, false, true, 0, late, false},
		{"ended", "", true, true, false, true, 0, late, false},
		{"another agent has no hooks to send", "codex", true, false, false, true, 0, late, false},
	}
	for _, c := range cases {
		if got := HeldAtStart(c.agent, c.owned, c.ended, c.hasHooks, c.hooksOn, c.events, start, c.now); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
	if HeldAtStart("", true, false, false, true, 0, time.Time{}, late) {
		t.Error("an unknown start time read as held")
	}
}

func TestStartPromptActivityWaitsOnYou(t *testing.T) {
	start := time.Date(2026, 11, 28, 10, 0, 0, 0, time.UTC)
	a := StartPromptActivity(start)
	if a.Health != HealthWaiting || a.Phrase != StartPromptPhrase || !a.At.Equal(start) {
		t.Fatalf("activity: %+v", a)
	}
	if a.Need == nil || a.Need.Reason != NeedStartPrompt || !a.Need.Guess {
		t.Fatalf("need: %+v", a.Need)
	}
}
