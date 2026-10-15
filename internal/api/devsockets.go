package api

import (
	"net/http"
	"sync"

	"github.com/coder/websocket"
)

// A paired device's open sockets, closed when the owner removes it or changes
// its role (ADR-067).
//
// The gate decides each request, but a socket is one request that lasts for
// hours. The terminal already asked the role again before every frame a
// device sent, so taking control away stopped the next keystroke; /v1/live
// asked nothing and kept streaming to a removed phone until it reconnected.
// Now every socket a device opens is held here by the device's id, and
// Remove, a role change, Deny and the device's own withdrawal close them at
// once with 1008 — the device reconnects, and the gate answers it as it now
// stands.

// deviceSockets is the open sockets by device id.
type deviceSockets struct {
	mu    sync.Mutex
	byDev map[string]map[*websocket.Conn]struct{}
}

// closeReason is what a closed device socket says.
const closeReason = "this device was removed or its access changed on the machine"

// hold records c as device id's until release is called. Never blocks.
func (d *deviceSockets) hold(id string, c *websocket.Conn) (release func()) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.byDev == nil {
		d.byDev = map[string]map[*websocket.Conn]struct{}{}
	}
	set := d.byDev[id]
	if set == nil {
		set = map[*websocket.Conn]struct{}{}
		d.byDev[id] = set
	}
	set[c] = struct{}{}
	return func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		if set := d.byDev[id]; set != nil {
			delete(set, c)
			if len(set) == 0 {
				delete(d.byDev, id)
			}
		}
	}
}

// close closes every socket of device id, or of every device for "".
// Returns how many it closed. The close handshake runs on its own goroutine:
// a device that never answers it must not hold up the owner's request.
func (d *deviceSockets) close(id string) int {
	d.mu.Lock()
	var cs []*websocket.Conn
	for dev, set := range d.byDev {
		if id != "" && dev != id {
			continue
		}
		for c := range set {
			cs = append(cs, c)
		}
		delete(d.byDev, dev)
	}
	d.mu.Unlock()
	for _, c := range cs {
		go func() { _ = c.Close(websocket.StatusPolicyViolation, closeReason) }()
	}
	return len(cs)
}

// holdSocket records an accepted socket as the requesting device's, when a
// device made it; the release is a no-op for the machine itself.
func (s *Server) holdSocket(r *http.Request, c *websocket.Conn) (release func()) {
	dev := deviceFrom(r)
	if dev == nil {
		return func() {}
	}
	return s.socks.hold(dev.ID, c)
}

// closeDeviceSockets closes device id's sockets ("" for every device's).
func (s *Server) closeDeviceSockets(id string) {
	if n := s.socks.close(id); n > 0 {
		s.d.Log.Info("closed a paired device's open sockets", "component", "api", "device", id, "sockets", n)
	}
}
