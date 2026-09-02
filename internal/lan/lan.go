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
)

// ErrNoAddress is returned when the machine has no private IPv4 address — a
// laptop with wifi off, or a host whose only route is a public address we
// deliberately will not bind.
var ErrNoAddress = errors.New("no private network address on this machine")

// Address returns the private IPv4 address a device on the same network would
// use to reach this machine.
//
// IPv4 only, and private only. A link-local address (169.254/16) means the
// interface never got a lease and nothing can route to it; a public address on
// an interface would put the dashboard on the internet, which is a different
// decision from "let my tablet in" and is not one this function will make on
// anyone's behalf.
//
// When several qualify — wifi and ethernet both up, or a VPN alongside either
// — the first in interface order wins and the rest are returned by Addresses
// so the user can be shown the choice rather than guessed at.
func Address() (net.IP, error) {
	all, err := Addresses()
	if err != nil {
		return nil, err
	}
	if len(all) == 0 {
		return nil, ErrNoAddress
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
	var out []net.IP
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
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP.To4()
			if ip == nil || !ip.IsPrivate() || ip.IsLinkLocalUnicast() {
				continue
			}
			out = append(out, ip)
		}
	}
	return out, nil
}
