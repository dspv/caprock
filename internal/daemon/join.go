package daemon

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
)

// Join keys (ADR-108): api.JoinControl over a peers.JoinDesk opened on first
// use, and the new computer's side of a join.
//
// Making a key is the one thing that dials a relay from this side before a
// computer is linked: on the click, to this machine's own relay (the one
// access from anywhere uses), for at most 15 minutes, carrying only Noise
// ciphertext (rule 4, ADR-047, ADR-058). Using one is `caprock join` run on
// the new computer, which is that computer's owner switching access from
// anywhere on and allowing the one computer that made the key.
type joinAdapter struct {
	d *Daemon

	once sync.Once
	desk *peers.JoinDesk
}

func (a *joinAdapter) mgr() *peers.JoinDesk {
	a.once.Do(func() {
		base := a.d.baseCtx
		if base == nil {
			base = context.Background()
		}
		a.desk = peers.NewJoinDesk(peers.JoinOptions{
			Relay: func() string { return a.d.RemoteState("").Relay },
			Controller: func() string {
				id := a.d.remoteIdentity()
				if id == nil {
					return ""
				}
				return remote.HostID(id.Public().(ed25519.PublicKey))
			},
			Name:    machineName(),
			Version: a.d.opt.Version,
			Log:     a.d.log,
			Pair:    a.d.machines.Pair,
			Base:    base,
		})
	})
	return a.desk
}

// close withdraws an open key, if a desk was ever opened.
func (a *joinAdapter) close() {
	a.once.Do(func() {})
	if a.desk != nil {
		a.desk.Close()
	}
}

func (a *joinAdapter) NewJoinKey() (peers.NewJoinKey, error) { return a.mgr().New() }

func (a *joinAdapter) JoinKeyState() peers.JoinState { return a.mgr().State() }

func (a *joinAdapter) WithdrawJoinKey() { a.mgr().Withdraw() }

// joinOnline bounds the wait for this computer's own relay connection
// before the other computer is asked to pair back through it.
const joinOnline = 30 * time.Second

// Join uses a key made on another computer: access from anywhere on here
// (at the key's relay when this computer has chosen none), a code that
// pre-approves that computer alone, and the link handed to it through the
// key's rendezvous.
func (a *joinAdapter) Join(ctx context.Context, key string) (api.JoinResult, error) {
	jk, err := remote.ParseJoinKey(key)
	if err != nil {
		return api.JoinResult{}, err
	}
	d := a.d
	res := api.JoinResult{Name: machineName()}
	if st := d.RemoteState(""); !st.Enabled {
		relay := ""
		d.mu.Lock()
		if d.remoteSet != nil && d.remoteSet.Relay == "" && jk.Relay != remote.DefaultRelay {
			// This computer never chose a relay: the one the other computer
			// waits at is the user's choice already.
			relay = jk.Relay
		}
		d.mu.Unlock()
		if err := d.SetRemote(true, relay, ""); err != nil {
			return api.JoinResult{}, fmt.Errorf("could not turn on access from anywhere here: %w", err)
		}
		res.TurnedOnRemote = true
	}
	if err := a.waitOnline(ctx); err != nil {
		return api.JoinResult{}, err
	}
	res.Relay = d.RemoteState("").Relay
	j, err := peers.Join(ctx, key, peers.JoinWithOptions{
		Name: machineName(),
		Log:  d.log,
		Link: func(_ context.Context, controller string) (string, error) {
			d.mu.Lock()
			ps := d.remoteStoreLocked()
			d.mu.Unlock()
			if ps == nil {
				return "", errors.New("access from anywhere went off here while joining")
			}
			code, err := ps.NewCodeForKey(controller)
			if err != nil {
				return "", err
			}
			link := d.RemoteState(code).Link
			if link == "" {
				ps.ClearCode()
				return "", errors.New("this computer has no link to give: access from anywhere is off here")
			}
			return link, nil
		},
		Cancel: func() {
			d.mu.Lock()
			ps := d.remoteStoreLocked()
			d.mu.Unlock()
			if ps != nil {
				ps.ClearCode()
			}
		},
	})
	if err != nil {
		return api.JoinResult{}, err
	}
	res.Joined = j
	d.log.Info("joined another computer with a key", "component", "peers", "controller", j.Controller, "controller_name", j.ControllerName)
	return res, nil
}

// waitOnline waits for this computer's relay connection.
func (a *joinAdapter) waitOnline(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, joinOnline)
	defer cancel()
	t := time.NewTicker(200 * time.Millisecond)
	defer t.Stop()
	for {
		st := a.d.RemoteState("")
		if st.Status == "online" {
			return nil
		}
		select {
		case <-ctx.Done():
			why := st.Error
			if why == "" {
				why = "it did not come online in time"
			}
			return fmt.Errorf("this computer could not reach its relay %s: %s", st.Relay, why)
		case <-t.C:
		}
	}
}
