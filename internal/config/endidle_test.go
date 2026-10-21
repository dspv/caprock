package config

import (
	"testing"
	"time"
)

func TestEndIdleWindow(t *testing.T) {
	for v, want := range map[string]time.Duration{"": 12 * time.Hour, "2h": 2 * time.Hour, "12h": 12 * time.Hour, "24h": 24 * time.Hour, "never": 0, "1h": 12 * time.Hour} {
		if got := EndIdleWindow(v); got != want {
			t.Errorf("EndIdleWindow(%q) = %v, want %v", v, got, want)
		}
	}
	if NormalizeEndIdle("") != EndIdle12h || ValidEndIdle("") || !ValidEndIdle(EndIdleNever) {
		t.Fatal("the unset choice must read as 12h and not be a valid one to store")
	}
}
