package lan

import (
	"net"
	"testing"
)

// The rule this package exists to keep: whatever it returns must be an address
// only the local network can reach. A public address here would put someone's
// dashboard — their prompts, their repository names — on the internet because
// they ticked a box that said "let my tablet in".
func TestOnlyPrivateIPv4IsOffered(t *testing.T) {
	got, err := Addresses()
	if err != nil {
		t.Fatal(err)
	}
	for _, ip := range got {
		if ip.To4() == nil {
			t.Errorf("%v is not IPv4", ip)
		}
		if !ip.IsPrivate() {
			t.Errorf("%v is not a private address — it must never be offered", ip)
		}
		if ip.IsLoopback() {
			t.Errorf("%v is loopback, which is what LAN access exists to differ from", ip)
		}
		if ip.IsLinkLocalUnicast() {
			t.Errorf("%v is link-local: the interface never got a lease, so nothing routes to it", ip)
		}
	}
}

// A machine with no network is a normal state, not a failure to crash on — a
// laptop with wifi off is the obvious case. The caller shows "no network"; it
// does not get an address it cannot bind.
func TestNoAddressIsAnAnswerNotACrash(t *testing.T) {
	ips, err := Addresses()
	if err != nil {
		t.Fatalf("listing interfaces failed: %v", err)
	}
	one, err := Address()
	switch {
	case len(ips) == 0:
		if err == nil {
			t.Fatal("no private addresses, but Address() returned one")
		}
	default:
		if err != nil {
			t.Fatalf("addresses exist but Address() failed: %v", err)
		}
		if !one.Equal(ips[0]) {
			t.Errorf("Address() = %v, want the first of %v", one, ips)
		}
	}
}

// Whatever comes back has to be bindable, or the daemon fails at the moment
// the user turns the feature on — the worst possible time to find out.
func TestTheAddressCanBeBound(t *testing.T) {
	ip, err := Address()
	if err != nil {
		t.Skip("no private address on this machine")
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(ip.String(), "0"))
	if err != nil {
		t.Fatalf("cannot bind %v: %v", ip, err)
	}
	_ = ln.Close()
}
