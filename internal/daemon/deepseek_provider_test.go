package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/subs"
)

const testDeepSeekKey = "sk-test-not-a-real-key-0000"

// Claude Code on DeepSeek is offered beside the sign-ins only while a key is
// set; the request names "deepseek" and the daemon, not the request, supplies
// the key; and it is not a sign-in: no directory, no windows, not renamed,
// removed or made the default, and not counted toward the free three.
func TestDeepSeekProvider(t *testing.T) {
	d := subsDaemon(t)
	a := &subsAdapter{d: d}
	ctx := context.Background()

	hasDeepSeek := func() *api.Subscription {
		t.Helper()
		list, err := a.List(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, g := range list.Agents {
			for i, s := range g.Subscriptions {
				if s.ID == subs.DeepSeekID {
					if g.Agent != subs.AgentClaude {
						t.Fatalf("DeepSeek listed under %s", g.Agent)
					}
					return &g.Subscriptions[i]
				}
			}
		}
		return nil
	}
	if hasDeepSeek() != nil {
		t.Fatal("DeepSeek offered with no key")
	}
	sr := agents.SpawnRequest{Subscription: subs.DeepSeekID}
	if err := d.resolveSubscription(&sr, nil); err == nil {
		t.Fatal("a DeepSeek session resolved with no key")
	}

	d.opt.Config.DeepSeekAPIKey = testDeepSeekKey
	ds := hasDeepSeek()
	if ds == nil {
		t.Fatal("DeepSeek not offered with a key set")
	}
	if ds.Provider != "deepseek" || !ds.SignedIn || ds.Dir != "" || ds.LoginCommand != "" || len(ds.Windows) != 0 || ds.Plan == nil || ds.Plan.Kind != "metered" {
		t.Fatalf("DeepSeek entry: %+v", *ds)
	}
	if b, _ := json.Marshal(ds); strings.Contains(string(b), testDeepSeekKey) {
		t.Fatal("the list carries the key")
	}

	sr = agents.SpawnRequest{Subscription: subs.DeepSeekID, Model: "claude-opus-5-5"}
	if err := d.resolveSubscription(&sr, nil); err != nil || sr.DeepSeekKey != testDeepSeekKey || sr.ConfigDir != "" || sr.Subscription != subs.DeepSeekID {
		t.Fatalf("resolve: sub %q dir %q key set %v, %v", sr.Subscription, sr.ConfigDir, sr.DeepSeekKey != "", err)
	}
	// The launcher's Claude model means nothing to DeepSeek: dropped.
	if sr.Model != "" {
		t.Fatalf("a Claude model was kept for a DeepSeek session: %q", sr.Model)
	}
	if err := d.resolveSubscription(&agents.SpawnRequest{Agent: "codex", Subscription: subs.DeepSeekID}, nil); err == nil {
		t.Fatal("codex resolved onto DeepSeek")
	}
	// A continued DeepSeek session stays on DeepSeek, whatever was asked.
	sr = agents.SpawnRequest{Resume: "x", Subscription: "default"}
	if err := d.resolveSubscription(&sr, &store.Session{Subscription: subs.DeepSeekID}); err != nil || sr.DeepSeekKey == "" {
		t.Fatalf("resume: %v", err)
	}
	// A session on the own sign-in never gets the key.
	sr = agents.SpawnRequest{}
	if err := d.resolveSubscription(&sr, nil); err != nil || sr.DeepSeekKey != "" {
		t.Fatalf("own sign-in got the key: %v", err)
	}

	// Not a sign-in: it cannot be renamed, made the default or removed, and
	// two subscriptions can still be added beside it for free.
	name := "x"
	if _, err := a.Update(ctx, subs.DeepSeekID, api.SubscriptionPatch{Label: &name}); !errors.Is(err, api.ErrSubscriptionNotFound) {
		t.Fatalf("rename DeepSeek: %v", err)
	}
	if _, err := a.Update(ctx, subs.DeepSeekID, api.SubscriptionPatch{MakeDefault: true}); !errors.Is(err, api.ErrSubscriptionNotFound) {
		t.Fatalf("make DeepSeek the default: %v", err)
	}
	if err := a.Remove(ctx, subs.DeepSeekID); !errors.Is(err, api.ErrSubscriptionNotFound) {
		t.Fatalf("remove DeepSeek: %v", err)
	}
	for _, l := range []string{"Work", "Home"} {
		if _, err := a.Add(ctx, "claude", l); err != nil {
			t.Fatalf("DeepSeek counted toward the free number: %v", err)
		}
	}

	// Revoked: no longer offered, and a session that ran on it says why it
	// cannot continue.
	d.opt.Config.DeepSeekAPIKey = ""
	if hasDeepSeek() != nil {
		t.Fatal("DeepSeek still offered after the key was cleared")
	}
	if err := d.resolveSubscription(&agents.SpawnRequest{Resume: "x"}, &store.Session{Subscription: subs.DeepSeekID}); err == nil || !strings.Contains(err.Error(), "DeepSeek") {
		t.Fatalf("continuing without a key: %v", err)
	}
}

// The status line's plan windows from a DeepSeek session would be filed under
// its own prefix, and the plan-window stop never pauses it.
func TestDeepSeekSessionIsNotTheDefaultSignIns(t *testing.T) {
	if p := subs.LimitPrefix(subs.DeepSeekID); p == "" || p == "five_hour" {
		t.Fatalf("prefix %q", p)
	}
	d := subsDaemon(t)
	ctx := context.Background()
	if err := store.UpsertSession(ctx, d.store.DB(), "s-ds", store.SessionPatch{Cwd: "/w", Agent: "claude", Subscription: subs.DeepSeekID}); err != nil {
		t.Fatal(err)
	}
	if dir := (&agentAdapter{d: d}).configDirOf(ctx, "s-ds"); dir != "" {
		t.Fatalf("a DeepSeek session's configuration directory: %q", dir)
	}
}
