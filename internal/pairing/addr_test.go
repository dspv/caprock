package pairing

import (
	"net"
	"testing"
)

// The single most important property here: a public address is never chosen.
// Binding one would put the dashboard on the internet behind a six-digit code,
// which is not a thing this product may ever do by accident.
func TestIsPrivateRefusesPublicAddresses(t *testing.T) {
	public := []string{
		"8.8.8.8",
		"1.1.1.1",
		"93.184.216.34",
		"172.32.0.1",  // just outside 172.16/12
		"192.169.0.1", // just outside 192.168/16
		"11.0.0.1",    // just outside 10/8
		"2606:4700::1111",
	}
	for _, s := range public {
		if isPrivate(net.ParseIP(s)) {
			t.Errorf("isPrivate(%s) = true — a public address must never be bound", s)
		}
	}
}

func TestIsPrivateAcceptsHomeNetworks(t *testing.T) {
	private := []string{
		"192.168.1.42",
		"10.0.0.5",
		"172.16.0.1",
		"172.31.255.254",
		"169.254.10.1", // link-local: no DHCP, but two devices on a cable
		"fd00::1",      // unique-local
		"fe80::1",      // link-local v6
	}
	for _, s := range private {
		if !isPrivate(net.ParseIP(s)) {
			t.Errorf("isPrivate(%s) = false — this is a network a tablet is on", s)
		}
	}
}

func TestIsPrivateRefusesNonsense(t *testing.T) {
	if isPrivate(nil) {
		t.Error("isPrivate(nil) = true")
	}
	if isPrivate(net.ParseIP("0.0.0.0")) {
		t.Error("isPrivate(0.0.0.0) = true — binding everything is what this exists to avoid")
	}
	if isPrivate(net.ParseIP("127.0.0.1")) {
		t.Error("isPrivate(127.0.0.1) = true — loopback is the other listener, not this one")
	}
}

func TestVirtualInterfacesAreNotPreferred(t *testing.T) {
	// A docker bridge has a private address and is not where the tablet is.
	for _, n := range []string{"docker0", "br-1a2b3c", "veth0", "utun4", "vmnet1", "awdl0"} {
		if !isVirtualName(n) {
			t.Errorf("isVirtualName(%q) = false", n)
		}
	}
	for _, n := range []string{"en0", "eth0", "wlan0", "enp3s0"} {
		if isVirtualName(n) {
			t.Errorf("isVirtualName(%q) = true — this is a real interface", n)
		}
	}
}

// BindAddr runs against whatever this machine has, so it cannot assert a
// value. What it can assert is the invariant: whatever comes back is private,
// or the call fails.
func TestBindAddrNeverReturnsAPublicAddress(t *testing.T) {
	addr, err := BindAddr()
	if err != nil {
		if err != ErrNoLAN {
			t.Fatalf("BindAddr: %v", err)
		}
		t.Skip("no private network on this machine")
	}
	ip := net.ParseIP(addr)
	if ip == nil {
		t.Fatalf("BindAddr returned %q, which is not an IP", addr)
	}
	if !isPrivate(ip) {
		t.Fatalf("BindAddr returned %s, which is not a private address", addr)
	}
}

// The choice itself, against machines this one is not.
func TestPick(t *testing.T) {
	ip := net.ParseIP
	cases := []struct {
		name  string
		cands []Candidate
		want  string
		err   error
	}{
		{
			name: "a laptop with wifi",
			cands: []Candidate{
				{Name: "en0", IP: ip("192.168.1.42")},
			},
			want: "192.168.1.42",
		},
		{
			// The case that must never regress: a machine with a public
			// address gets no LAN listener rather than a public one.
			name: "a cloud host with only a public address",
			cands: []Candidate{
				{Name: "eth0", IP: ip("203.0.113.7")},
			},
			err: ErrNoLAN,
		},
		{
			name: "a public address alongside a private one",
			cands: []Candidate{
				{Name: "eth0", IP: ip("203.0.113.7")},
				{Name: "eth1", IP: ip("10.0.0.5")},
			},
			want: "10.0.0.5",
		},
		{
			// Docker is not where the tablet is, even though it is listed
			// first and is perfectly private.
			name: "a docker bridge before the wifi",
			cands: []Candidate{
				{Name: "docker0", IP: ip("172.17.0.1")},
				{Name: "en0", IP: ip("192.168.1.42")},
			},
			want: "192.168.1.42",
		},
		{
			name: "nothing but a docker bridge",
			cands: []Candidate{
				{Name: "docker0", IP: ip("172.17.0.1")},
			},
			want: "172.17.0.1",
		},
		{
			name:  "no interfaces at all",
			cands: nil,
			err:   ErrNoLAN,
		},
	}
	for _, c := range cases {
		got, err := pick(c.cands)
		if c.err != nil {
			if err != c.err {
				t.Errorf("%s: err = %v, want %v", c.name, err, c.err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: unexpected error %v", c.name, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s: pick = %s, want %s", c.name, got, c.want)
		}
	}
}
