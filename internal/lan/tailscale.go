package lan

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Other returns the first address of the other kind than primary: the
// Tailscale address when primary is a LAN one, the LAN address when primary
// is Tailscale's. Nil when there is none.
//
// LAN access listens on both when both exist (WP-15): a phone on the same
// Wi-Fi uses the LAN address, one on mobile data the Tailscale one, and the
// pairing panel offers each as a QR. Still named addresses, never 0.0.0.0.
func Other(primary net.IP) net.IP {
	all, err := Addresses()
	if err != nil {
		return nil
	}
	return other(all, primary)
}

func other(all []net.IP, primary net.IP) net.IP {
	if primary == nil {
		return nil
	}
	want := !Tunnelled(primary)
	for _, ip := range all {
		if Tunnelled(ip) == want && !ip.Equal(primary) {
			return ip
		}
	}
	return nil
}

// tailscaleStatus is the part of `tailscale status --json` read here.
type tailscaleStatus struct {
	Self struct {
		DNSName      string   `json:"DNSName"`
		TailscaleIPs []string `json:"TailscaleIPs"`
	} `json:"Self"`
}

// magicDNSName reads this machine's MagicDNS name from `tailscale status
// --json`, and only when that name belongs to ip: a name for another address
// would be a QR code that opens nothing.
func magicDNSName(raw []byte, ip net.IP) string {
	var st tailscaleStatus
	if err := json.Unmarshal(raw, &st); err != nil {
		return ""
	}
	name := strings.TrimSuffix(strings.TrimSpace(st.Self.DNSName), ".")
	if name == "" || strings.ContainsAny(name, " /:@") {
		return ""
	}
	for _, s := range st.Self.TailscaleIPs {
		if parsed := net.ParseIP(s); parsed != nil && parsed.Equal(ip) {
			return strings.ToLower(name)
		}
	}
	return ""
}

// tailscaleCLIs are where the Tailscale CLI is, in the order tried: on PATH,
// then inside the macOS app, which does not put one on PATH.
func tailscaleCLIs() []string {
	out := []string{}
	if p, err := exec.LookPath("tailscale"); err == nil {
		out = append(out, p)
	}
	if runtime.GOOS == "darwin" {
		const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
		if _, err := os.Stat(app); err == nil {
			out = append(out, app)
		}
	}
	return out
}

// MagicDNSName is the MagicDNS name of this machine's Tailscale address ip
// ("mac.tailnet-1234.ts.net"), or "" when Tailscale's CLI is missing, slow,
// MagicDNS is off, or the name is not ip's.
//
// Read-only: `tailscale status --json` asks the local tailscaled over its
// socket and changes nothing. Nothing reaches the network, and Tailscale's
// own configuration is never written.
func MagicDNSName(ctx context.Context, ip net.IP) string {
	if ip == nil || !Tunnelled(ip) {
		return ""
	}
	for _, cli := range tailscaleCLIs() {
		c, cancel := context.WithTimeout(ctx, 2*time.Second)
		raw, err := exec.CommandContext(c, cli, "status", "--json").Output() //nolint:gosec // fixed binary, fixed args
		cancel()
		if err != nil {
			continue
		}
		if name := magicDNSName(raw, ip); name != "" {
			return name
		}
	}
	return ""
}
