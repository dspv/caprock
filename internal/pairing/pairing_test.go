package pairing

import (
	"errors"
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
	if _, err := s.Redeem(code, "second"); !errors.Is(err, ErrNoCode) {
		t.Errorf("second redeem: err = %v, want ErrNoCode", err)
	}
}

func TestCodeExpires(t *testing.T) {
	// A code left on screen must not be a standing invitation.
	s, now := clock(t)
	code, _ := s.NewCode()
	*now = now.Add(CodeTTL + time.Second)
	if _, err := s.Redeem(code, "late"); !errors.Is(err, ErrNoCode) {
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
		if _, err := s.Redeem("000000", "attacker"); !errors.Is(err, ErrBadCode) {
			t.Fatalf("attempt %d: err = %v, want ErrBadCode", i, err)
		}
	}
	// The real code is now worthless too — that is the point.
	if _, err := s.Redeem(code, "the owner"); !errors.Is(err, ErrNoCode) {
		t.Errorf("after %d wrong guesses: err = %v, want the code burned", MaxAttempts, err)
	}
}

func TestUnknownTokenIsRefused(t *testing.T) {
	s, _ := clock(t)
	if _, err := s.Check("not-a-token"); !errors.Is(err, ErrUnknownDevice) {
		t.Errorf("err = %v, want ErrUnknownDevice", err)
	}
	if _, err := s.Check(""); !errors.Is(err, ErrUnknownDevice) {
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
	if _, err := s.Check(d.Token); !errors.Is(err, ErrUnknownDevice) {
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
	if _, err := s.Redeem(c2, "sneaking in"); !errors.Is(err, ErrNoCode) {
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
	if _, err := s.Check(""); !errors.Is(err, ErrUnknownDevice) {
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

// ADR-034: pairing makes a viewer, always. Control is a second decision made
// on the machine, never something a code can grant.
func TestPairingMakesAViewer(t *testing.T) {
	s, _ := clock(t)
	code, _ := s.NewCode()
	d, err := s.Redeem(code, "phone")
	if err != nil {
		t.Fatal(err)
	}
	if d.Role != RoleViewer {
		t.Fatalf("a freshly paired device is %q, want viewer", d.Role)
	}
	if got := s.RoleOf(d.Token); got != RoleViewer {
		t.Fatalf("RoleOf = %q", got)
	}
}

func TestSetRoleGivesAndTakesControl(t *testing.T) {
	s, _ := clock(t)
	code, _ := s.NewCode()
	d, _ := s.Redeem(code, "phone")

	if !s.SetRole(d.ID, RoleController) {
		t.Fatal("SetRole refused a paired device")
	}
	if got := s.RoleOf(d.Token); got != RoleController {
		t.Fatalf("after promotion RoleOf = %q", got)
	}
	if c, _ := s.Check(d.Token); c.Role != RoleController {
		t.Fatalf("Check reports %q", c.Role)
	}
	if got := s.Devices()[0].Role; got != RoleController {
		t.Fatalf("Devices lists %q", got)
	}
	if !s.SetRole(d.ID, RoleViewer) || s.RoleOf(d.Token) != RoleViewer {
		t.Fatal("control was not taken away")
	}

	if s.SetRole("no-such-id", RoleController) {
		t.Fatal("SetRole accepted an unknown device")
	}
	if s.SetRole(d.ID, "owner") {
		t.Fatal("SetRole accepted a role that does not exist")
	}
	if s.RoleOf("not-a-token") != "" || s.RoleOf("") != "" {
		t.Fatal("an unknown token has a role")
	}
}

// A revoked controller has no role at all: an open terminal asks RoleOf per
// keystroke, and must stop.
func TestARevokedControllerHasNoRole(t *testing.T) {
	s, _ := clock(t)
	code, _ := s.NewCode()
	d, _ := s.Redeem(code, "phone")
	s.SetRole(d.ID, RoleController)
	s.Revoke(d.ID)
	if got := s.RoleOf(d.Token); got != "" {
		t.Fatalf("a revoked device still holds %q", got)
	}
}

// Check hands out a copy, so the role a request was admitted with cannot be
// changed under it without the lock — and changing the copy changes nothing.
func TestCheckReturnsACopy(t *testing.T) {
	s, _ := clock(t)
	code, _ := s.NewCode()
	d, _ := s.Redeem(code, "phone")
	c, _ := s.Check(d.Token)
	c.Role = RoleController
	if s.RoleOf(d.Token) != RoleViewer {
		t.Fatal("editing Check's result promoted the stored device")
	}
}

// Every devices.json written before roles existed has no "role" key. Those
// devices were viewers, and must still be.
func TestADeviceSavedBeforeRolesIsAViewer(t *testing.T) {
	s := New()
	s.Load([]Device{{ID: "old", Name: "tablet", Token: "tok-old", PairedAt: 1}})
	if got := s.RoleOf("tok-old"); got != RoleViewer {
		t.Fatalf("legacy device role = %q, want viewer", got)
	}
	if got := s.Devices()[0].Role; got != RoleViewer {
		t.Fatalf("legacy device listed as %q", got)
	}
	// And the role survives a save and a load.
	s.SetRole("old", RoleController)
	again := New()
	again.Load(s.Snapshot())
	if got := again.RoleOf("tok-old"); got != RoleController {
		t.Fatalf("role lost across Snapshot/Load: %q", got)
	}
}

// How a device last reached the machine is recorded per request, reported as
// changed only when it is new, kept by an empty route, and survives a
// Snapshot/Load round trip.
func TestCheckViaRecordsTheRoute(t *testing.T) {
	s := New()
	code, err := s.NewCode()
	if err != nil {
		t.Fatal(err)
	}
	d, err := s.Redeem(code, "Android phone")
	if err != nil {
		t.Fatal(err)
	}
	if _, changed, err := s.CheckVia(d.Token, ViaLAN); err != nil || !changed {
		t.Fatalf("first route: changed %v, err %v", changed, err)
	}
	if _, changed, _ := s.CheckVia(d.Token, ViaLAN); changed {
		t.Fatal("the same route again was reported as changed")
	}
	if _, changed, _ := s.CheckVia(d.Token, ""); changed {
		t.Fatal("an unknown route was reported as changed")
	}
	if got := s.Devices()[0].Via; got != ViaLAN {
		t.Fatalf("an unknown route overwrote it: %q", got)
	}
	if dev, changed, _ := s.CheckVia(d.Token, ViaRelay); !changed || dev.Via != ViaRelay {
		t.Fatalf("moving to the relay: changed %v, %+v", changed, dev)
	}
	again := New()
	again.Load(s.Snapshot())
	if got := again.Devices()[0].Via; got != ViaRelay {
		t.Fatalf("after a restart: %q", got)
	}
	if _, _, err := s.CheckVia("nope", ViaLAN); !errors.Is(err, ErrUnknownDevice) {
		t.Fatalf("unknown token: %v", err)
	}
}

// A code issued as a controller pairs a controller; any other code, and a
// role the store does not know, pairs a viewer (ADR-034, amended 2026-10-14).
func TestACodeCarriesItsRole(t *testing.T) {
	for _, tc := range []struct{ issue, want string }{
		{RoleController, RoleController},
		{RoleViewer, RoleViewer},
		{"owner", RoleViewer},
		{"", RoleViewer},
	} {
		s := New()
		code, err := s.NewCodeAs(tc.issue)
		if err != nil {
			t.Fatal(err)
		}
		if got := s.CodeRole(); got != tc.want {
			t.Errorf("issued %q: CodeRole %q, want %q", tc.issue, got, tc.want)
		}
		d, err := s.Redeem(code, "phone")
		if err != nil {
			t.Fatal(err)
		}
		if d.Role != tc.want || s.RoleOf(d.Token) != tc.want {
			t.Errorf("issued %q: paired as %q, want %q", tc.issue, d.Role, tc.want)
		}
		if s.CodeRole() != "" {
			t.Error("a spent code still names a role")
		}
	}
	// The next code is its own decision: a controller code does not make the
	// one after it a controller.
	s := New()
	_, _ = s.NewCodeAs(RoleController)
	code, _ := s.NewCode()
	d, _ := s.Redeem(code, "phone")
	if d.Role != RoleViewer {
		t.Errorf("a plain code after a controller one paired %q", d.Role)
	}
}

func TestSetAppIsRecordedAndListed(t *testing.T) {
	s := New()
	code, _ := s.NewCode()
	d, _ := s.Redeem(code, "phone")
	if !s.SetApp(d.Token, true) {
		t.Fatal("first report not a change")
	}
	if s.SetApp(d.Token, true) {
		t.Error("the same report counted as a change")
	}
	if s.SetApp("nobody", true) {
		t.Error("an unknown token was recorded")
	}
	if l := s.Devices(); len(l) != 1 || !l[0].App {
		t.Errorf("not listed as installed: %+v", l)
	}
}

// A code for a computer pairs one that waits: a controller only once the
// owner allows it by id, and the kind comes from the code, never the device
// (ADR-067).
func TestAComputerCodePairsAPendingMachine(t *testing.T) {
	s := New()
	code, err := s.NewCodeFor(RoleViewer, KindMachine)
	if err != nil {
		t.Fatal(err)
	}
	if s.CodeKind() != KindMachine || s.CodeRole() != RoleController {
		t.Fatalf("code kind %q role %q", s.CodeKind(), s.CodeRole())
	}
	d, err := s.Redeem(code, "MacBook")
	if err != nil {
		t.Fatal(err)
	}
	if d.Kind != KindMachine || !d.Pending {
		t.Fatalf("redeemed %+v", d)
	}
	if s.CodeKind() != KindPhone {
		t.Fatal("the spent code still names a kind")
	}
	// Pending holds no role: a terminal asking per keystroke is refused.
	if got := s.RoleOf(d.Token); got != RoleViewer {
		t.Fatalf("a pending computer's role reads %q", got)
	}
	got, err := s.Check(d.Token)
	if err != nil || !got.Pending || got.Role != RoleViewer {
		t.Fatalf("check: %+v %v", got, err)
	}
	if s.Allow("nope") {
		t.Fatal("allowed an unknown id")
	}
	if !s.Allow(d.ID) {
		t.Fatal("could not allow")
	}
	if s.Allow(d.ID) {
		t.Fatal("allowed twice")
	}
	if got := s.RoleOf(d.Token); got != RoleController {
		t.Fatalf("an allowed computer's role reads %q", got)
	}
	ds := s.Devices()
	if len(ds) != 1 || ds[0].Kind != KindMachine || ds[0].Pending || ds[0].Role != RoleController {
		t.Fatalf("listed %+v", ds)
	}
	// Kept across a restart.
	s2 := New()
	s2.Load(s.Snapshot())
	if p := s2.Devices(); p[0].Kind != KindMachine || p[0].Pending {
		t.Fatalf("after load %+v", p)
	}
}

// A phone's code pairs a phone, whatever the device says it is.
func TestAPhoneCodeNeverPairsAMachine(t *testing.T) {
	s := New()
	code, _ := s.NewCodeFor(RoleController, "something")
	d, err := s.Redeem(code, "machine")
	if err != nil {
		t.Fatal(err)
	}
	if d.Kind != KindPhone || d.Pending || d.Role != RoleController {
		t.Fatalf("redeemed %+v", d)
	}
	if s.Allow(d.ID) {
		t.Fatal("a phone was 'allowed' as if it waited")
	}
}
