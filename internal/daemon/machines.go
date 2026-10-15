package daemon

import (
	"context"
	"net/http"
	"sync"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/peers"
)

// Other computers (ADR-067): this daemon as a relay client to the user's
// other daemons. The dashboard and the app only ever talk to this daemon;
// it holds the channel to each computer and the token there, in
// machines.json beside remote.json and devices.json.
//
// Nothing here is dialled until the user pastes a computer's link: the
// relay is that computer's own choice, and Forget undoes it (rule 4,
// ADR-047). Channels open on demand and close after 90 s with nothing open.

// machinesAdapter is api.Machines over a peers.Manager opened on first use,
// so a daemon whose owner never links a computer reads machines.json only
// when asked.
type machinesAdapter struct {
	d *Daemon

	once sync.Once
	m    *peers.Manager
}

func (a *machinesAdapter) mgr() *peers.Manager {
	a.once.Do(func() {
		// This machine's own relay id, read under the daemon's lock as the
		// pairing panel reads it (never a second load of remote.json, which
		// could write keys of its own).
		self := a.d.RemoteState("").HostID
		m, err := peers.Open(peers.Options{Dir: a.d.opt.DataDir, Self: self, Name: machineName(), Log: a.d.log})
		if err != nil {
			a.d.log.Warn("could not read the computers this one reaches; listing none", "component", "peers", "err", err)
		}
		a.m = m
	})
	return a.m
}

// close hangs up every channel, if a manager was ever opened. Once it has
// run, no later call opens one.
func (a *machinesAdapter) close() {
	a.once.Do(func() {})
	if a.m != nil {
		a.m.Close()
	}
}

func (a *machinesAdapter) List() []peers.Status { return a.mgr().List() }

func (a *machinesAdapter) Get(id string) (peers.Status, error) { return a.mgr().Get(id) }

func (a *machinesAdapter) Check(ctx context.Context, id string) (peers.Status, error) {
	return a.mgr().Check(ctx, id)
}

func (a *machinesAdapter) Pair(ctx context.Context, link string) (peers.Status, error) {
	return a.mgr().Pair(ctx, link)
}

func (a *machinesAdapter) Rename(id, name string) error { return a.mgr().Rename(id, name) }

func (a *machinesAdapter) Leave(ctx context.Context, id string) error {
	return a.mgr().Leave(ctx, id)
}

func (a *machinesAdapter) Forget(id string) error { return a.mgr().Forget(id) }

func (a *machinesAdapter) Do(id string, req *http.Request) (*http.Response, error) {
	return a.mgr().Do(id, req)
}

func (a *machinesAdapter) OpenWS(ctx context.Context, id, path string, protocols []string) (api.MachineSocket, error) {
	ws, err := a.mgr().OpenWS(ctx, id, path, protocols)
	if err != nil {
		return nil, err
	}
	return ws, nil
}
