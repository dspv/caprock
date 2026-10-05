package lan

import (
	"context"
	"net"
	"testing"
)

// With LAN access on, a machine on Wi-Fi and Tailscale listens on one
// address of each kind; Other finds the second from the first, either way
// round, and nothing when there is only one kind.
func TestOtherIsTheAddressOfTheOtherKind(t *testing.T) {
	ip := net.ParseIP
	wifi, wifi2, ts := ip("192.168.1.20"), ip("10.0.0.5"), ip("100.101.102.103")
	for _, tc := range []struct {
		name    string
		all     []net.IP
		primary net.IP
		want    net.IP
	}{
		{"Tailscale primary, Wi-Fi second", []net.IP{wifi, ts, wifi2}, ts, wifi},
		{"Wi-Fi primary, Tailscale second", []net.IP{wifi, ts}, wifi, ts},
		{"Wi-Fi only", []net.IP{wifi, wifi2}, wifi, nil},
		{"Tailscale only", []net.IP{ts}, ts, nil},
		{"nothing bound", []net.IP{wifi}, nil, nil},
	} {
		got := other(tc.all, tc.primary)
		if !got.Equal(tc.want) && (got != nil || tc.want != nil) {
			t.Errorf("%s: %v, want %v", tc.name, got, tc.want)
		}
	}
}

// The MagicDNS name is taken from `tailscale status --json` only when it is
// the name of the address Caprock listens on; otherwise the QR would open a
// name that reaches nothing.
func TestMagicDNSNameBelongsToTheBoundAddress(t *testing.T) {
	ts := net.ParseIP("100.101.102.103")
	status := []byte(`{"Self":{"DNSName":"Studio-Mac.tail1234.ts.net.","TailscaleIPs":["100.101.102.103","fd7a:115c:a1e0::1"]}}`)
	if got := magicDNSName(status, ts); got != "studio-mac.tail1234.ts.net" {
		t.Fatalf("name: %q", got)
	}
	for _, tc := range []struct {
		name string
		raw  string
	}{
		{"another address", `{"Self":{"DNSName":"mac.tail1234.ts.net.","TailscaleIPs":["100.64.0.9"]}}`},
		{"MagicDNS off", `{"Self":{"DNSName":"","TailscaleIPs":["100.101.102.103"]}}`},
		{"not JSON", `tailscale is stopped`},
		{"a name that is not a host", `{"Self":{"DNSName":"a b/c","TailscaleIPs":["100.101.102.103"]}}`},
	} {
		if got := magicDNSName([]byte(tc.raw), ts); got != "" {
			t.Errorf("%s: %q, want none", tc.name, got)
		}
	}
	// Never asked for a LAN address, so a machine without Tailscale runs nothing.
	if got := MagicDNSName(context.Background(), net.ParseIP("192.168.1.20")); got != "" {
		t.Errorf("a LAN address has a MagicDNS name: %q", got)
	}
}
