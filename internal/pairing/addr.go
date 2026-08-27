package pairing

import (
	"errors"
	"fmt"
	"net"
)

// ErrNoLAN means the machine has no private network address to bind to —
// no wifi, no ethernet, or every interface is down.
var ErrNoLAN = errors.New("this machine has no private network address")

// BindAddr is the address to listen on for LAN access.
//
// Deliberately not `0.0.0.0`. Binding to everything is one firewall rule away
// from being on the public internet, and on a machine with a public IP it is
// on the public internet immediately. This picks one private address instead,
// so the listener is reachable from the user's own network and nowhere else —
// even if a router is misconfigured, there is no path to a socket that is not
// listening.
//
// The address is chosen from the interfaces that are up, are not loopback, and
// carry an RFC 1918 / RFC 4193 address. Where several qualify (wifi plus a
// docker bridge, say) the first non-virtual one wins, because that is the one
// the tablet is on.
func BindAddr() (string, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", fmt.Errorf("list interfaces: %w", err)
	}
	cands := make([]Candidate, 0, len(ifaces))
	for _, ifi := range ifaces {
		if ifi.Flags&net.FlagUp == 0 || ifi.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifi.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok {
				cands = append(cands, Candidate{Name: ifi.Name, IP: ipn.IP})
			}
		}
	}
	return pick(cands)
}

// Candidate is one interface address BindAddr is choosing between. Exported so
// the choice can be tested against machines this one is not — a laptop with a
// public address, a host with nothing but a docker bridge.
type Candidate struct {
	Name string
	IP   net.IP
}

// pick applies the rules: private only, real interfaces before virtual ones.
func pick(cands []Candidate) (string, error) {
	var fallback string
	for _, c := range cands {
		if !isPrivate(c.IP) {
			continue
		}
		// Virtual interfaces carry private addresses too, and a container
		// bridge is not where the tablet is. Keep one as a fallback in case it
		// is genuinely all there is.
		if isVirtualName(c.Name) {
			if fallback == "" {
				fallback = c.IP.String()
			}
			continue
		}
		return c.IP.String(), nil
	}
	if fallback != "" {
		return fallback, nil
	}
	return "", ErrNoLAN
}

// isPrivate reports whether ip is one a home or office network hands out.
//
// Link-local (169.254/16, fe80::/10) counts: a machine with no DHCP still has
// one, and two devices on the same cable can reach each other over it. Public
// addresses never count, whatever the interface claims.
func isPrivate(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsLoopback() {
		return false
	}
	if ip4 := ip.To4(); ip4 != nil {
		return ip4.IsPrivate() || ip4.IsLinkLocalUnicast()
	}
	// IPv6: unique-local (fc00::/7) and link-local only.
	return ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

// isVirtualName reports whether an interface is the sort a container runtime
// or VPN creates, rather than the wifi or ethernet a tablet is on.
func isVirtualName(name string) bool {
	for _, p := range []string{"docker", "br-", "veth", "virbr", "vmnet", "utun", "tun", "tap", "bridge", "awdl", "llw"} {
		if len(name) >= len(p) && name[:len(p)] == p {
			return true
		}
	}
	return false
}
