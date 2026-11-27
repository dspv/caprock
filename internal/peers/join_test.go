package peers_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
)

// desk is a join desk on the target's relay, pairing through m, with a
// controller key made here.
func desk(t *testing.T, tg *target, m *peers.Manager, ttl time.Duration) (*peers.JoinDesk, string) {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ctrl := remote.HostID(pub)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	d := peers.NewJoinDesk(peers.JoinOptions{
		Relay:      func() string { return tg.set.Relay },
		Controller: func() string { return ctrl },
		Name:       "MacBook",
		Pair:       m.Pair,
		Base:       ctx,
		TTL:        ttl,
	})
	t.Cleanup(d.Close)
	return d, ctrl
}

// waitDesk waits for the rendezvous to reach its relay.
func waitDesk(t *testing.T, d *peers.JoinDesk) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for d.State().RelayStatus != "online" {
		if time.Now().After(deadline) {
			t.Fatalf("the rendezvous never reached the relay: %+v", d.State())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestAJoinKeyLinksTheComputerOnceAndPreApprovesOnlyTheIssuer(t *testing.T) {
	tg := newTarget(t)
	m := open(t, t.TempDir())
	d, ctrl := desk(t, tg, m, 0)
	k, err := d.New()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(k.Key, remote.JoinKeyPrefix) || k.State != peers.JoinWaiting || k.ExpiresAt == 0 {
		t.Fatalf("new key = %+v", k)
	}
	waitDesk(t, d)
	// The key is in the answer that made it and in no later one.
	st, _ := json.Marshal(d.State())
	jk, _ := remote.ParseJoinKey(k.Key)
	if strings.Contains(string(st), k.Key) || strings.Contains(string(st), string(jk.Secret)) {
		t.Fatalf("the state carries the key: %s", st)
	}

	var asked string
	j, err := peers.Join(ctx5(t), k.Key, peers.JoinWithOptions{
		Name: "mini",
		Link: func(_ context.Context, controller string) (string, error) {
			asked = controller
			return tg.link("123456"), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if asked != ctrl || j.Controller != ctrl || j.ControllerName != "MacBook" || j.Status != "online" {
		t.Fatalf("joined = %+v, asked for %q, want %q", j, asked, ctrl)
	}
	got := d.State()
	if got.State != peers.JoinJoined || got.Machine == nil || got.Machine.ID != tg.keys.HostID() || got.Joiner != "mini" {
		t.Fatalf("desk after the join = %+v", got)
	}
	if list := m.List(); len(list) != 1 || list[0].ID != tg.keys.HostID() {
		t.Fatalf("machines = %+v", list)
	}

	// Single use: the same key again reaches nothing.
	_, err = peers.Join(ctx5(t), k.Key, peers.JoinWithOptions{Name: "mini", Link: func(context.Context, string) (string, error) {
		t.Fatal("a spent key minted a second link")
		return "", nil
	}})
	if !errors.Is(err, peers.ErrJoinGone) && !errors.Is(err, peers.ErrJoinRefused) {
		t.Fatalf("a spent key: %v", err)
	}
}

func TestWrongSecretsBurnAJoinKey(t *testing.T) {
	tg := newTarget(t)
	m := open(t, t.TempDir())
	d, _ := desk(t, tg, m, 0)
	k, err := d.New()
	if err != nil {
		t.Fatal(err)
	}
	waitDesk(t, d)
	jk, _ := remote.ParseJoinKey(k.Key)
	jk.Secret[0] ^= 0xff
	wrong := jk.String()
	for i := 0; i < peers.JoinTries; i++ {
		_, err := peers.Join(ctx5(t), wrong, peers.JoinWithOptions{Link: func(context.Context, string) (string, error) {
			t.Fatal("a wrong secret minted a link")
			return "", nil
		}})
		if !errors.Is(err, peers.ErrJoinRefused) {
			t.Fatalf("try %d: %v", i, err)
		}
	}
	if st := d.State(); st.State != peers.JoinFailed {
		t.Fatalf("after %d wrong secrets: %+v", peers.JoinTries, st)
	}
	// The right one no longer works either.
	if _, err := peers.Join(ctx5(t), k.Key, peers.JoinWithOptions{Link: func(context.Context, string) (string, error) { return tg.link("1"), nil }}); err == nil {
		t.Fatal("a burned key still joined")
	}
}

func TestAJoinKeyExpiresAndCanBeWithdrawn(t *testing.T) {
	tg := newTarget(t)
	m := open(t, t.TempDir())
	d, _ := desk(t, tg, m, 400*time.Millisecond)
	if _, err := d.New(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for d.State().State != peers.JoinExpired {
		if time.Now().After(deadline) {
			t.Fatalf("never expired: %+v", d.State())
		}
		time.Sleep(20 * time.Millisecond)
	}

	d2, _ := desk(t, tg, m, 0)
	k, err := d2.New()
	if err != nil {
		t.Fatal(err)
	}
	waitDesk(t, d2)
	d2.Withdraw()
	if st := d2.State(); st.State != peers.JoinNone {
		t.Fatalf("after withdraw: %+v", st)
	}
	_, err = peers.Join(ctx5(t), k.Key, peers.JoinWithOptions{Link: func(context.Context, string) (string, error) { return tg.link("1"), nil }})
	if !errors.Is(err, peers.ErrJoinGone) {
		t.Fatalf("a withdrawn key: %v", err)
	}
}

func TestNoKeyWithoutAControllerIdentity(t *testing.T) {
	d := peers.NewJoinDesk(peers.JoinOptions{Controller: func() string { return "" }})
	if _, err := d.New(); !errors.Is(err, peers.ErrNoIdentity) {
		t.Fatalf("err = %v", err)
	}
}
