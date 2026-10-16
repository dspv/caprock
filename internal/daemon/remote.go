package daemon

import (
	"context"
	"errors"
	"net"
	"os"
	"strconv"
	"strings"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/pairing"
	"github.com/dspv/caprock/internal/remote"
)

// Access from anywhere (ADR-058): this machine waits at a relay, and phones
// paired with it reach its API through an end-to-end encrypted channel.
//
// The relay is never trusted with anything but delivery. The phone pins this
// machine's key from the QR, and every request it makes arrives on loopback
// marked as relayed, so the gate treats it as a paired device — the same
// tokens, roles and revocation as on the LAN.

// startRemoteFromSettings turns remote access on at startup when it was on
// before. Called once, after the server listens.
func (d *Daemon) startRemoteFromSettings(ctx context.Context) {
	d.mu.Lock()
	defer d.mu.Unlock()
	// The server already listens, so a request may have read or switched
	// access first (RemoteState, SetRemote, both of which load remote.json
	// under this lock). What it holds is as new or newer. Reading the file
	// outside the lock and storing it here afterwards left a host online
	// with a stale "off", and every pairing link came back empty (seen on
	// Windows, where the first request beat this); with no remote.json yet,
	// two loads could also each write different keys. startRemoteLocked does
	// nothing when a host already runs.
	if d.remoteSet == nil {
		set, err := remote.Load(d.opt.DataDir)
		if err != nil {
			d.log.Warn("could not read the remote access settings", "component", "remote", "err", err)
			return
		}
		d.remoteSet = set
	}
	if !d.remoteSet.Enabled {
		return
	}
	if err := d.startRemoteLocked(ctx); err != nil {
		d.log.Warn("could not start access from anywhere", "component", "remote", "err", err)
	}
}

// startRemoteLocked connects to the relay. Callers hold d.mu.
func (d *Daemon) startRemoteLocked(ctx context.Context) error {
	if d.remoteStop != nil {
		return nil
	}
	if d.srv == nil || d.port == 0 {
		return errors.New("the daemon is not serving yet")
	}
	keys, err := d.remoteSet.Keys()
	if err != nil {
		return err
	}
	if d.pairing == nil {
		d.pairing = pairing.New()
		if snap, err := config.ReadDevices(d.opt.DataDir); err == nil {
			d.pairing.Load(snap)
		}
	}
	// The guest list must be live before the first phone arrives: with it
	// nil the gate treats a relayed request as if no network existed.
	d.api.SetLAN(d.pairing, d.lanURL)
	h := remote.NewHost(remote.Options{
		Relay:   d.remoteSet.RelayURL(),
		Keys:    keys,
		Local:   "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(d.port)),
		Version: d.opt.Version,
		Name:    machineName(),
		Log:     d.log,
	})
	base := d.baseCtx
	if base == nil {
		base = ctx
	}
	rctx, stop := context.WithCancel(base)
	d.remoteHost, d.remoteStop = h, stop
	go h.Run(rctx)
	return nil
}

// stopRemoteLocked disconnects from the relay. Paired phones are kept, as
// with LAN access: they are the guest list, not the open door.
func (d *Daemon) stopRemoteLocked() {
	if d.remoteStop != nil {
		d.remoteStop()
	}
	d.remoteStop, d.remoteHost = nil, nil
	if d.lanLn == nil {
		d.api.SetLAN(nil, "")
	}
}

// remoteStoreLocked is the guest list while remote access needs it, else nil.
func (d *Daemon) remoteStoreLocked() *pairing.Store {
	if d.remoteStop != nil {
		return d.pairing
	}
	return nil
}

// SetRemote implements api.RemoteControl.
func (d *Daemon) SetRemote(on bool, relay, app string) error {
	if relay != "" {
		if err := remote.CheckRelayURL(relay); err != nil {
			return err
		}
	}
	if app != "" {
		if err := remote.CheckAppURL(app); err != nil {
			return err
		}
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.remoteSet == nil {
		set, err := remote.Load(d.opt.DataDir)
		if err != nil {
			return err
		}
		d.remoteSet = set
	}
	changed := (relay != "" && relay != d.remoteSet.Relay) || (app != "" && app != d.remoteSet.App)
	if relay != "" {
		d.remoteSet.Relay = relay
	}
	if app != "" {
		d.remoteSet.App = app
	}
	d.remoteSet.Enabled = on
	if err := remote.Save(d.opt.DataDir, d.remoteSet); err != nil {
		return err
	}
	if !on || changed {
		d.stopRemoteLocked()
	}
	if on {
		ctx := d.baseCtx
		if ctx == nil {
			ctx = context.Background()
		}
		return d.startRemoteLocked(ctx)
	}
	return nil
}

// RemoteState implements api.RemoteControl.
func (d *Daemon) RemoteState(code string) api.RemoteState {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.remoteSet == nil {
		set, err := remote.Load(d.opt.DataDir)
		if err != nil {
			return api.RemoteState{Status: "off", Error: err.Error()}
		}
		d.remoteSet = set
	}
	st := api.RemoteState{
		Enabled: d.remoteSet.Enabled,
		Status:  "off",
		Relay:   d.remoteSet.RelayURL(),
		App:     d.remoteSet.AppURL(),
	}
	if d.remoteHost != nil {
		hs := d.remoteHost.State()
		st.Status, st.Error, st.Phones = hs.Status, hs.Error, hs.Phones
	}
	if keys, err := d.remoteSet.Keys(); err == nil {
		st.HostID = keys.HostID()
		if st.Enabled {
			st.Link = remote.PairLink(d.remoteSet, keys, code, machineName())
		}
	}
	return st
}

// machineName is what a phone calls this machine until told otherwise: the
// host name without the ".local" macOS appends.
func machineName() string {
	n, err := os.Hostname()
	if err != nil || n == "" {
		return "Caprock"
	}
	return strings.TrimSuffix(n, ".local")
}
