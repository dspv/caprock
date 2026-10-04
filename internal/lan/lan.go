// Package lan finds the address a second device on the same network can reach
// this machine at.
//
// The daemon binds loopback and nothing else unless the user turns LAN access
// on. When they do, it binds **one named address** rather than `0.0.0.0`.
// The difference matters: `0.0.0.0` accepts on every interface a machine has
// now or acquires later — a VPN that comes up, a container bridge, a phone
// tethered over USB — and none of those were what the user agreed to. A single
// address is a promise that can be shown on screen and checked.
//
// Nothing here reaches the network. The addresses come from the kernel's own
// interface list; no name is registered, no discovery packet is sent, and
// nothing outside the machine learns that Caprock is running until somebody
// types a code into it.
package lan

import (
	"errors"
	"net"
	"strings"
)

// ErrNoAddress is returned when the machine has no private IPv4 address — a
// laptop with wifi off, or a host whose only route is a public address we
// deliberately will not bind.
var ErrNoAddress = errors.New("no private network address on this machine")

// tailscaleCGNAT is the range a Tailscale address comes from: 100.64.0.0/10,
// the carrier-grade NAT block reserved by RFC 6598.
//
// It is not "private" in Go's sense — `net.IP.IsPrivate` covers RFC 1918 only
// — so the address of the one interface that actually solves this problem was
// being filtered out. A tunnel address is exactly as safe to bind as a LAN
// one, and considerably more useful: it reaches a tablet on mobile data, which
// a LAN address never will. It is admitted only on Tailscale's own interface —
// see isTailscale for why the range alone is not enough.
var tailscaleCGNAT = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

// Tunnelled reports whether ip is a Tailscale address rather than a LAN one.
// The dashboard says which, because they answer different questions: a LAN
// address works at home and nowhere else; a tunnel address works anywhere the
// other device has the tunnel too.
func Tunnelled(ip net.IP) bool {
	v4 := ip.To4()
	return v4 != nil && tailscaleCGNAT.Contains(v4)
}

// Address returns the private IPv4 address a device on the same network would
// use to reach this machine.
//
// IPv4 only, and private only. A link-local address (169.254/16) means the
// interface never got a lease and nothing can route to it; a public address on
// an interface would put the dashboard on the internet, which is a different
// decision from "let my tablet in" and is not one this function will make on
// anyone's behalf.
//
// A Tailscale address wins when there is one. It is the address that reaches a
// tablet on mobile data — a LAN address only works on the same network, which
// is the case the person asking for this usually does not have. Otherwise the
// first private address in interface order wins, and the rest are returned by
// Addresses so the user can be shown the choice rather than guessed at.
func Address() (net.IP, error) {
	all, err := Addresses()
	if err != nil {
		return nil, err
	}
	if len(all) == 0 {
		return nil, ErrNoAddress
	}
	for _, ip := range all {
		if Tunnelled(ip) {
			return ip, nil
		}
	}
	return all[0], nil
}

// Addresses returns every private IPv4 address on an interface that is up,
// in the order the kernel lists them.
func Addresses() ([]net.IP, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	all := make([]Interface, 0, len(ifaces))
	for _, ifc := range ifaces {
		// Down means nothing can arrive on it; loopback is the thing LAN
		// access exists to be different from.
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue // one unreadable interface must not hide the others
		}
		one := Interface{Name: ifc.Name}
		for _, a := range addrs {
			if ipnet, ok := a.(*net.IPNet); ok {
				one.IPs = append(one.IPs, ipnet.IP)
			}
		}
		all = append(all, one)
	}
	return choose(all), nil
}

// Interface is one network interface as Addresses sees it: a name and every
// address on it. Separate from net.Interface so the choice can be tested
// against machines this one is not — a laptop behind a carrier's NAT, a host
// running Tailscale, a VPN that borrows the same range.
type Interface struct {
	Name string
	IPs  []net.IP
}

// choose applies the rules to the interfaces that are up, in kernel order.
func choose(ifaces []Interface) []net.IP {
	var out []net.IP
	for _, ifc := range ifaces {
		tailscale := isTailscale(ifc)
		for _, raw := range ifc.IPs {
			ip := raw.To4()
			if ip == nil || ip.IsLinkLocalUnicast() || ip.IsLoopback() {
				continue
			}
			// Private (RFC 1918), or the Tailscale range on Tailscale's own
			// interface. Nothing else: a public address on an interface would
			// put the dashboard on the internet, which is a different decision
			// from "let my phone in".
			switch {
			case ip.IsPrivate():
			case Tunnelled(ip) && tailscale:
			default:
				continue
			}
			out = append(out, ip)
		}
	}
	return out
}

// tailscaleULA is the IPv6 prefix Tailscale gives every node,
// fd7a:115c:a1e0::/48. It is Tailscale's own, so an interface carrying an
// address in it is Tailscale's whatever the OS named it.
var tailscaleULA = &net.IPNet{IP: net.ParseIP("fd7a:115c:a1e0::"), Mask: net.CIDRMask(48, 128)}

// isTailscale reports whether an interface is Tailscale's tunnel.
//
// 100.64.0.0/10 is not Tailscale's range: it is the carrier-grade NAT block,
// and Tailscale borrows it. A laptop tethered to a phone, or on an ISP that
// does CGNAT, can hold an address in it on its wifi interface — and binding
// that would invite every other customer behind the same carrier NAT. Other
// VPNs borrow it too (Cloudflare WARP puts 100.96.0.0/12 on a utun). So the
// range is admitted only on an interface that is Tailscale's:
//
//   - named tailscale* — Linux calls it tailscale0, Windows "Tailscale";
//   - or carrying an address in Tailscale's own IPv6 prefix — macOS names it
//     utunN like every other tunnel, but Tailscale puts its fd7a:115c:a1e0::
//     address on the same interface.
func isTailscale(ifc Interface) bool {
	if strings.HasPrefix(strings.ToLower(ifc.Name), "tailscale") {
		return true
	}
	for _, ip := range ifc.IPs {
		if ip.To4() == nil && tailscaleULA.Contains(ip) {
			return true
		}
	}
	return false
}
