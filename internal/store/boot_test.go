package store

import (
	"testing"
	"time"
)

func TestBootTimeIsInThePast(t *testing.T) {
	b := BootTime()
	if b.IsZero() {
		t.Skip("this platform cannot report its boot time")
	}
	if !b.Before(time.Now()) || time.Since(b) > 5*365*24*time.Hour {
		t.Fatalf("boot time %v is not a plausible past moment", b)
	}
}
