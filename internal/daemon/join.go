package daemon

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
	"github.com/dspv/caprock/internal/serverscript"
)

// Join keys (ADR-108): api.JoinControl over a peers.JoinDesk opened on first
// use, and the new computer's side of a join.
//
// Making a key is the one thing that dials a relay from this side before a
// computer is linked: on the click, to this machine's own relay (the one
// access from anywhere uses), for at most 15 minutes (60 for a server key,
// ADR-109), carrying only Noise ciphertext (rule 4, ADR-047, ADR-058). Using
// one is `caprock join` run on the new computer, which is that computer's
// owner switching access from anywhere on and allowing the one computer that
// made the key.
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

// releaseBaseEnv points the setup script's downloads, and the checksums read
// for it, at another address: for the container test, which serves the
// archive from a local file server. Unset, they are GitHub's.
const releaseBaseEnv = "CAPROCK_TEST_RELEASE_BASE"

// NewServerScript is New server (ADR-109): the release to install read
// first — the laptop's own version, or the latest release for a development
// build — so a GitHub that does not answer opens no key; then a server key
// (60 minutes), and the script with both inside. The checksums come from
// GitHub, which the release check already talks to (rule 4: no new
// destination), on this click.
func (a *joinAdapter) NewServerScript(ctx context.Context, req api.ServerScriptRequest) (api.ServerScript, error) {
	ver := a.d.opt.Version
	if !serverscript.IsRelease(ver) {
		if err := a.d.upd.Check(ctx, true); err != nil {
			return api.ServerScript{}, fmt.Errorf("%w: this is a development build, and the latest release could not be read: %w", api.ErrNoRelease, err)
		}
		ver = a.d.upd.Status(true, ver).Latest
	}
	ver = strings.TrimPrefix(ver, "v")
	base := os.Getenv(releaseBaseEnv)
	hc := &http.Client{Timeout: 20 * time.Second}
	rel, err := serverscript.FetchRelease(ctx, hc, base, ver)
	if err != nil {
		return api.ServerScript{}, fmt.Errorf("%w: %w", api.ErrNoRelease, err)
	}
	k, err := a.mgr().NewServer()
	if err != nil {
		return api.ServerScript{}, err
	}
	script, err := serverscript.Render(serverscript.Input{
		Version: rel.Version,
		SHA256:  rel.SHA256,
		Signed:  rel.Signed,
		JoinKey: k.Key,
		SSHKey:  req.SSHKey,
		Base:    base,
	})
	if err != nil {
		a.mgr().Withdraw()
		return api.ServerScript{}, err
	}
	a.d.log.Info("a server's setup script was made", "component", "peers", "version", rel.Version, "signed", rel.Signed, "ssh_key", req.SSHKey)
	return api.ServerScript{JoinState: k.JoinState, Script: script, Version: rel.Version, Signed: rel.Signed}, nil
}

// serverScriptDir holds the scripts I already have a server writes: one
// 0600 file per key, gone once that key is spent, withdrawn or expired, and
// all of them at the daemon's start.
func (a *joinAdapter) serverScriptDir() string {
	return filepath.Join(a.d.opt.DataDir, "server-scripts")
}

// serverScriptPoll is how often a saved script's key is looked at.
var serverScriptPoll = 5 * time.Second

// clearServerScripts removes every saved script: at start, none of their
// keys can still be open.
func (a *joinAdapter) clearServerScripts() {
	if a.d.opt.DataDir != "" {
		_ = os.RemoveAll(a.serverScriptDir())
	}
}

// NewServerSSH is I already have a server (ADR-109, amended 2026-11-28): the
// script with SSH kept on, keys only (the user logs in over SSH to run it,
// and the script turns password login off), saved to a 0600 file, and the
// user's own ssh command for this computer's terminal. The file is removed
// as soon as the key is no longer open.
func (a *joinAdapter) NewServerSSH(ctx context.Context, t serverscript.SSHTarget) (api.ServerSSH, error) {
	if err := t.Check(); err != nil {
		return api.ServerSSH{}, err
	}
	if a.d.opt.DataDir == "" {
		return api.ServerSSH{}, errors.New("no data directory to keep the script in")
	}
	s, err := a.NewServerScript(ctx, api.ServerScriptRequest{SSHKey: true})
	if err != nil {
		return api.ServerSSH{}, err
	}
	dir := a.serverScriptDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		a.mgr().Withdraw()
		return api.ServerSSH{}, err
	}
	f, err := os.CreateTemp(dir, "caprock-setup-*.sh")
	if err != nil {
		a.mgr().Withdraw()
		return api.ServerSSH{}, err
	}
	path := f.Name()
	_, werr := f.WriteString(s.Script)
	cerr := f.Close()
	if err := errors.Join(werr, cerr, os.Chmod(path, 0o600)); err != nil {
		_ = os.Remove(path)
		a.mgr().Withdraw()
		return api.ServerSSH{}, err
	}
	cmd, err := serverscript.SSHCommand(runtime.GOOS, t, path)
	if err != nil {
		_ = os.Remove(path)
		a.mgr().Withdraw()
		return api.ServerSSH{}, err
	}
	go a.removeWhenSpent(path, s.ExpiresAt)
	a.d.log.Info("a server's setup script was saved for ssh", "component", "peers", "version", s.Version, "port", t.Port, "root", t.User == "root")
	return api.ServerSSH{JoinState: s.JoinState, Command: cmd, OS: runtime.GOOS, Version: s.Version, Signed: s.Signed}, nil
}

// removeWhenSpent removes path once the key that opened at expires is no
// longer waiting: joined, failed, withdrawn, replaced or expired.
func (a *joinAdapter) removeWhenSpent(path string, expires int64) {
	defer func() { _ = os.Remove(path) }()
	base := a.d.baseCtx
	if base == nil {
		base = context.Background()
	}
	t := time.NewTicker(serverScriptPoll)
	defer t.Stop()
	for {
		select {
		case <-base.Done():
			return
		case <-t.C:
			st := a.mgr().State()
			if st.ExpiresAt != expires || (st.State != peers.JoinWaiting && st.State != peers.JoinJoining) {
				return
			}
		}
	}
}

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
