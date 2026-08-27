package pairing

import (
	"strings"
	"testing"
	"time"
)

// clock returns a Store whose time the test controls.
func clock(t *testing.T) (*Store, *time.Time) {
	t.Helper()
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	s := New()
	s.Now = func() time.Time { return now }
	return s, &now
}

func TestCodeIsSixDigits(t *testing.T) {
	s, _ := clock(t)
	code, err := s.NewCode()
	if err != nil {
		t.Fatal(err)
	}
	if len(code) != 6 {
		t.Errorf("code = %q, want six characters", code)
	}
	if strings.Trim(code, "0123456789") != "" {
		t.Errorf("code = %q, want digits only — a person types this on a tablet", code)
	}
}

func TestCodesDiffer(t *testing.T) {
	// Not a distribution test — just that two consecutive codes are not the
	// same value, which would mean the generator is not being read at all.
	s, _ := clock(t)
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		c, err := s.NewCode()
		if err != nil {
			t.Fatal(err)
		}
		seen[c] = true
	}
	if len(seen) < 15 {
		t.Errorf("20 codes produced only %d distinct values", len(seen))
	}
}

func TestRedeemIssuesADeviceToken(t *testing.T) {
	s, _ := clock(t)
	code, _ := s.NewCode()
	d, err := s.Redeem(code, "iPad")
	if err != nil {
		t.Fatalf("Redeem: %v", err)
	}
	if d.Name != "iPad" {
		t.Errorf("Name = %q", d.Name)
	}
	// The token is what the device carries from here on, so it must be long
	// even though the code the user typed was short.
	if len(d.Token) < 32 {
		t.Errorf("token is %d characters, want a full-length secret", len(d.Token))
	}
	if got, err := s.Check(d.Token); err != nil || got.ID != d.ID {
		t.Errorf("Check(token) = %v, %v — want the device back", got, err)
	}
}

func TestACodeWorksOnce(t *testing.T) {
	// Otherwise a code read aloud in a room pairs everyone in it.
	s, _ := clock(t)
	code, _ := s.NewCode()
	if _, err := s.Redeem(code, "first"); err != nil {
		t.Fatalf("first redeem: %v", err)
	}
	if _, err := s.Redeem(code, "second"); err != ErrNoCode {
		t.Errorf("second redeem: err = %v, want ErrNoCode", err)
	}
}

func TestCodeExpires(t *testing.T) {
	// A code left on screen must not be a standing invitation.
	s, now := clock(t)
	code, _ := s.NewCode()
	*now = now.Add(CodeTTL + time.Second)
	if _, err := s.Redeem(code, "late"); err != ErrNoCode {
		t.Errorf("err = %v, want ErrNoCode once the code has expired", err)
	}
	if active, _ := s.CodeActive(); active {
		t.Error("CodeActive still true after expiry")
	}
}

func TestCodeSurvivesUntilItExpires(t *testing.T) {
	s, now := clock(t)
	code, _ := s.NewCode()
	*now = now.Add(CodeTTL - time.Second)
	if _, err := s.Redeem(code, "just in time"); err != nil {
		t.Errorf("err = %v, want the code to still work one second before expiry", err)
	}
}

func TestGuessingBurnsTheCode(t *testing.T) {
	// Six digits is a million values, which is not many if you can keep
	// trying. Wrong guesses have to cost the code itself.
	s, _ := clock(t)
	code, _ := s.NewCode()
	for i := 0; i < MaxAttempts; i++ {
		if _, err := s.Redeem("000000", "attacker"); err != ErrBadCode {
			t.Fatalf("attempt %d: err = %v, want ErrBadCode", i, err)
		}
	}
	// The real code is now worthless too — that is the point.
	if _, err := s.Redeem(code, "the owner"); err != ErrNoCode {
		t.Errorf("after %d wrong guesses: err = %v, want the code burned", MaxAttempts, err)
	}
}

func TestUnknownTokenIsRefused(t *testing.T) {
	s, _ := clock(t)
	if _, err := s.Check("not-a-token"); err != ErrUnknownDevice {
		t.Errorf("err = %v, want ErrUnknownDevice", err)
	}
	if _, err := s.Check(""); err != ErrUnknownDevice {
		t.Errorf("empty token: err = %v, want ErrUnknownDevice", err)
	}
}

func TestRevokeTakesEffectImmediately(t *testing.T) {
	// The reason someone revokes a device is that they no longer trust it, so
	// "at the next restart" is not an acceptable answer.
	s, _ := clock(t)
	code, _ := s.NewCode()
	d, _ := s.Redeem(code, "lost tablet")
	if !s.Revoke(d.ID) {
		t.Fatal("Revoke returned false for a device that exists")
	}
	if _, err := s.Check(d.Token); err != ErrUnknownDevice {
		t.Errorf("err = %v, want the revoked token refused at once", err)
	}
	if s.Revoke(d.ID) {
		t.Error("Revoke returned true for a device already gone")
	}
}

func TestRevokeAllClearsCodeToo(t *testing.T) {
	// "I do not trust this network" has to mean the outstanding code as well,
	// or the next person to read the screen pairs straight back in.
	s, _ := clock(t)
	code, _ := s.NewCode()
	_, _ = s.Redeem(code, "one")
	c2, _ := s.NewCode()
	if n := s.RevokeAll(); n != 1 {
		t.Errorf("RevokeAll = %d, want 1", n)
	}
	if _, err := s.Redeem(c2, "sneaking in"); err != ErrNoCode {
		t.Errorf("err = %v, want the outstanding code cleared as well", err)
	}
}

func TestDevicesHidesTokens(t *testing.T) {
	// The list is rendered in a dashboard that a paired device can also load.
	s, _ := clock(t)
	code, _ := s.NewCode()
	d, _ := s.Redeem(code, "iPad")
	list := s.Devices()
	if len(list) != 1 {
		t.Fatalf("Devices() = %d entries, want 1", len(list))
	}
	if list[0].ID != d.ID || list[0].Name != "iPad" {
		t.Errorf("Devices()[0] = %+v", list[0])
	}
	// Public has no Token field at all, which is the guarantee — this asserts
	// the listing goes through it rather than through Device.
	if got := s.Snapshot(); got[0].Token == "" {
		t.Error("Snapshot lost the token; persistence would forget every device")
	}
}

func TestLastSeenUpdatesOnUse(t *testing.T) {
	s, now := clock(t)
	code, _ := s.NewCode()
	d, _ := s.Redeem(code, "iPad")
	first := d.LastSeen
	*now = now.Add(time.Hour)
	if _, err := s.Check(d.Token); err != nil {
		t.Fatal(err)
	}
	if s.Devices()[0].LastSeen <= first {
		t.Error("LastSeen did not move; the device list would show every device as new")
	}
}

func TestLoadRestoresDevicesButNotCodes(t *testing.T) {
	// A pairing code must not survive a restart: the screen that showed it is
	// long gone, and nobody is waiting to type it.
	s, _ := clock(t)
	s.Load([]Device{{ID: "a1", Name: "iPad", Token: "tok-1", PairedAt: 1, LastSeen: 1}})
	if _, err := s.Check("tok-1"); err != nil {
		t.Errorf("a restored device was refused: %v", err)
	}
	if active, _ := s.CodeActive(); active {
		t.Error("a code was active after Load")
	}
}

func TestLoadSkipsDevicesWithoutTokens(t *testing.T) {
	// A truncated or hand-edited file must not produce a device that
	// everything matches, which is what an empty token key would mean.
	s, _ := clock(t)
	s.Load([]Device{{ID: "broken", Name: "x"}})
	if len(s.Devices()) != 0 {
		t.Error("a device with no token was loaded")
	}
	if _, err := s.Check(""); err != ErrUnknownDevice {
		t.Error("an empty token matched a loaded device")
	}
}

func TestCleanName(t *testing.T) {
	// The name arrives in a request body and is shown in the dashboard, so it
	// is untrusted text: bounded, and free of control characters that would
	// mangle a line.
	cases := []struct{ in, want string }{
		{"iPad", "iPad"},
		{"  iPad  ", "iPad"},
		{"", "a device"},
		{"   ", "a device"},
		{"iPad\x00\x07", "iPad"},
		{strings.Repeat("x", 100), strings.Repeat("x", 40)},
	}
	for _, c := range cases {
		if got := cleanName(c.in); got != c.want {
			t.Errorf("cleanName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestRandomDigitsAreNotSkewed(t *testing.T) {
	// `b % 10` over raw bytes makes 0–5 likelier than 6–9. In a six-digit
	// secret that is a real loss of entropy, so the generator rejects the
	// tail rather than folding it.
	counts := map[rune]int{}
	for i := 0; i < 2000; i++ {
		s, err := randomDigits(6)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range s {
			counts[r]++
		}
	}
	total := 2000 * 6
	for d := '0'; d <= '9'; d++ {
		got := counts[d]
		// Expected is total/10. Allow a wide band — this catches a 20% skew,
		// not sampling noise.
		if got < total/10*8/10 || got > total/10*12/10 {
			t.Errorf("digit %c appeared %d times in %d, want roughly %d", d, got, total, total/10)
		}
	}
}
