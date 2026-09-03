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
		// Private (RFC 1918) or the Tailscale range. A public address here
		// would put someone's dashboard on the internet because they ticked a
		// box that said "let my tablet in".
		if !ip.IsPrivate() && !Tunnelled(ip) {
			t.Errorf("%v is neither private nor a tunnel address — it must never be offered", ip)
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

// A tunnel address is the one that reaches a tablet on mobile data.
//
// `net.IP.IsPrivate` covers RFC 1918 only, so Tailscale's range — 100.64.0.0/10,
// the carrier-grade NAT block — was being filtered out as public. The feature
// exists for someone whose tablet is *not* on the same wifi, and the only
// address that helps them was the one being discarded.
func TestTheTailscaleRangeIsRecognised(t *testing.T) {
	for _, tc := range []struct {
		ip   string
		want bool
	}{
		{"100.64.0.1", true},      // first address of the range
		{"100.101.102.103", true}, // a typical Tailscale address
		{"100.127.255.254", true}, // last address of the range
		{"100.63.255.255", false}, // just below it — public
		{"100.128.0.0", false},    // just above it — public
		{"192.168.1.5", false},    // private, but a LAN address
		{"8.8.8.8", false},
	} {
		if got := Tunnelled(net.ParseIP(tc.ip)); got != tc.want {
			t.Errorf("Tunnelled(%s) = %v, want %v", tc.ip, got, tc.want)
		}
	}
}

// When both exist, the tunnel wins: a LAN address works at home and nowhere
// else, and the person asking for this is usually not at home.
func TestATunnelAddressIsPreferredOverALANOne(t *testing.T) {
	all, err := Addresses()
	if err != nil {
		t.Fatal(err)
	}
	var hasTunnel bool
	for _, ip := range all {
		if Tunnelled(ip) {
			hasTunnel = true
		}
	}
	if !hasTunnel {
		t.Skip("no tunnel on this machine")
	}
	chosen, err := Address()
	if err != nil {
		t.Fatal(err)
	}
	if !Tunnelled(chosen) {
		t.Errorf("chose %v with a tunnel address available — the tunnel is the one that reaches another network", chosen)
	}
}
