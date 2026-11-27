package pairing

import (
	"errors"
	"testing"
)

// A join's code (ADR-108) lets in the computer whose key it names, at once
// and bound to that key, and no one else.
func TestAJoinCodeAllowsOnlyTheKeyItNames(t *testing.T) {
	s, _ := clock(t)
	code, err := s.NewCodeForKey("key-of-the-laptop")
	if err != nil {
		t.Fatal(err)
	}
	if s.CodeKind() != KindMachine || s.CodeRole() != RoleController {
		t.Fatalf("a join code pairs %q as %q", s.CodeKind(), s.CodeRole())
	}
	d, err := s.RedeemFrom(code, "MacBook", "key-of-the-laptop")
	if err != nil {
		t.Fatal(err)
	}
	if d.Pending || d.Kind != KindMachine || d.Key != "key-of-the-laptop" || roleOf(d) != RoleController {
		t.Fatalf("joined device = %+v", d)
	}
	if ok, _ := s.HoldKey(d.Token, "another-key"); ok {
		t.Fatal("a joined computer's token works from another key")
	}
	if ok, bound := s.HoldKey(d.Token, "key-of-the-laptop"); !ok || bound {
		t.Fatalf("its own key: ok=%v bound=%v", ok, bound)
	}
}

func TestAJoinCodeFromAnotherKeyIsBurned(t *testing.T) {
	for _, peer := range []string{"someone-else", ""} {
		s, _ := clock(t)
		code, _ := s.NewCodeForKey("key-of-the-laptop")
		if _, err := s.RedeemFrom(code, "x", peer); !errors.Is(err, ErrBadCode) {
			t.Fatalf("from %q: err = %v", peer, err)
		}
		if s.Code() != "" {
			t.Fatalf("from %q: the code survived", peer)
		}
		if _, err := s.RedeemFrom(code, "x", "key-of-the-laptop"); err == nil {
			t.Fatal("a burned join code still pairs")
		}
		if len(s.Devices()) != 0 {
			t.Fatalf("devices = %+v", s.Devices())
		}
	}
}

func TestAnOrdinaryCodeAfterAJoinCodeWaitsForAllow(t *testing.T) {
	s, _ := clock(t)
	if _, err := s.NewCodeForKey("key-of-the-laptop"); err != nil {
		t.Fatal(err)
	}
	code, _ := s.NewCodeFor(RoleController, KindMachine)
	d, err := s.RedeemFrom(code, "MacBook", "key-of-the-laptop")
	if err != nil {
		t.Fatal(err)
	}
	if !d.Pending || d.Key != "" {
		t.Fatalf("a code shown after a join's code pre-approved: %+v", d)
	}
	if _, err := s.NewCodeForKey(""); err == nil {
		t.Fatal("a join code with no key")
	}
}
