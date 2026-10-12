package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/hooks"
	"github.com/dspv/caprock/internal/loop"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/subs"
)

func subsDaemon(t *testing.T) *Daemon {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &Daemon{
		store: st, log: log, bus: bus.New(), baseCtx: context.Background(),
		mgr:   agents.NewManager(st, t.TempDir(), "", log),
		opt:   Options{Config: config.Defaults(), DataDir: t.TempDir(), DisableIngest: true},
		table: &cost.Table{}, det: loop.New(5, time.Minute),
		start: time.Now(),
	}
}

func TestSubscriptionsAddRenameRemove(t *testing.T) {
	d := subsDaemon(t)
	a := &subsAdapter{d: d}
	ctx := context.Background()

	work, err := a.Add(ctx, "claude", "  Work  Max ")
	if err != nil {
		t.Fatal(err)
	}
	if work.Label != "Work Max" || work.EnvVar != "CLAUDE_CONFIG_DIR" || work.SignedIn || work.LoginCommand == "" {
		t.Fatalf("added: %+v", work)
	}
	dir := subs.Dir(d.opt.DataDir, work.ID)
	if st, err := hooks.Inspect(filepath.Join(dir, "settings.json"), hooks.ShimCommand(d.opt.DataDir)); err != nil || len(st.Missing) != 0 {
		t.Fatalf("hooks in the new directory: %+v %v", st, err)
	}
	// Saved, so a restart keeps it.
	saved, err := config.Load(d.opt.DataDir)
	if err != nil || len(saved.Subscriptions) != 1 {
		t.Fatalf("saved: %+v %v", saved.Subscriptions, err)
	}

	if _, err := a.Add(ctx, "claude", "work max"); err == nil {
		t.Fatal("a second subscription with the same name was added")
	}
	if _, err := a.Add(ctx, "claude", "Default"); err == nil {
		t.Fatal("a subscription called Default was added")
	}
	if _, err := a.Add(ctx, "gemini", "x"); err == nil {
		t.Fatal("a gemini subscription was added")
	}
	if _, err := a.Add(ctx, "claude", "Personal"); err != nil {
		t.Fatal(err)
	}
	// Three per agent are free, the Default one included.
	if _, err := a.Add(ctx, "claude", "Third"); !errors.Is(err, api.ErrSubscriptionPremium) {
		t.Fatalf("a fourth Claude Code sign-in without a licence: %v", err)
	}
	// Codex counts on its own.
	if _, err := a.Add(ctx, "codex", "Team"); err != nil {
		t.Fatal(err)
	}

	list, err := a.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Agents) != 2 || len(list.Agents[0].Subscriptions) != 3 || !list.Agents[0].Subscriptions[0].Default || list.Agents[0].Subscriptions[0].ID != subs.DefaultID {
		t.Fatalf("list: %+v", list.Agents)
	}
	if list.FreePerAgent != 3 || list.Licensed {
		t.Fatalf("list header: %+v", list)
	}

	name := func(s string) *string { return &s }
	got, err := a.Update(ctx, work.ID, api.SubscriptionPatch{Label: name("Work")})
	if err != nil || got.Label != "Work" {
		t.Fatalf("rename: %+v %v", got, err)
	}
	if _, err := a.Update(ctx, "nope", api.SubscriptionPatch{Label: name("x")}); !errors.Is(err, api.ErrSubscriptionNotFound) {
		t.Fatalf("rename unknown: %v", err)
	}

	if err := a.Remove(ctx, work.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("directory still there: %v", err)
	}
	if err := a.Remove(ctx, work.ID); !errors.Is(err, api.ErrSubscriptionNotFound) {
		t.Fatalf("remove twice: %v", err)
	}
}

func TestResolveSubscription(t *testing.T) {
	d := subsDaemon(t)
	a := &subsAdapter{d: d}
	ctx := context.Background()
	cx, err := a.Add(ctx, "codex", "Team")
	if err != nil {
		t.Fatal(err)
	}
	sr := agents.SpawnRequest{Agent: "codex", Subscription: cx.ID}
	if err := d.resolveSubscription(&sr, nil); err != nil || sr.ConfigDir != subs.Dir(d.opt.DataDir, cx.ID) {
		t.Fatalf("codex: %+v %v", sr, err)
	}
	// A Codex subscription does not start Claude Code.
	sr = agents.SpawnRequest{Subscription: cx.ID}
	if err := d.resolveSubscription(&sr, nil); err == nil {
		t.Fatal("a codex subscription started claude")
	}
	// The request cannot name a directory: ConfigDir is not a JSON field.
	sr = agents.SpawnRequest{Subscription: "default", ConfigDir: "/etc"}
	if err := d.resolveSubscription(&sr, nil); err != nil || sr.ConfigDir != "" || sr.Subscription != "" {
		t.Fatalf("default: %+v %v", sr, err)
	}
	// A continued session keeps the subscription it ran on, whatever was asked.
	sr = agents.SpawnRequest{Agent: "codex", Resume: "x"}
	if err := d.resolveSubscription(&sr, &store.Session{Agent: "codex", Subscription: cx.ID}); err != nil || sr.Subscription != cx.ID {
		t.Fatalf("resume: %+v %v", sr, err)
	}
	if err := d.resolveSubscription(&agents.SpawnRequest{Resume: "x"}, &store.Session{Subscription: "gone1"}); err == nil {
		t.Fatal("a session on a removed subscription was continued")
	}
}

// Make default, a renamed own sign-in and a plan per subscription — the
// tester's two complaints (2026-10-12): the default could not be changed
// without signing it in again, and one plan stood for every account.
func TestSubscriptionsMakeDefaultAndPlans(t *testing.T) {
	d := subsDaemon(t)
	a := &subsAdapter{d: d}
	ctx := context.Background()
	work, err := a.Add(ctx, "claude", "Work")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Add(ctx, "claude", "Personal"); err != nil {
		t.Fatal(err)
	}
	preferred := func() []string {
		list, err := a.List(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, g := range list.Agents {
			for _, s := range g.Subscriptions {
				if s.Preferred {
					out = append(out, g.Agent+":"+s.Label)
				}
			}
		}
		return out
	}
	if got := preferred(); len(got) != 2 || got[0] != "claude:Own sign-in" || got[1] != "codex:Own sign-in" {
		t.Fatalf("before: %v", got)
	}

	// No subscription asked for: the own sign-in, as before.
	sr := agents.SpawnRequest{}
	if err := d.resolveSubscription(&sr, nil); err != nil || sr.ConfigDir != "" {
		t.Fatalf("own: %+v %v", sr, err)
	}

	got, err := a.Update(ctx, work.ID, api.SubscriptionPatch{MakeDefault: true})
	if err != nil || !got.Preferred {
		t.Fatalf("make default: %+v %v", got, err)
	}
	if got := preferred(); len(got) != 2 || got[0] != "claude:Work" {
		t.Fatalf("after: %v", got)
	}
	// Saved, so a restart keeps it.
	if saved, err := config.Load(d.opt.DataDir); err != nil || saved.DefaultSubscription["claude"] != work.ID {
		t.Fatalf("saved: %+v %v", saved.DefaultSubscription, err)
	}
	// Now a request that names none runs on Work; "default" is still the
	// own sign-in; Codex is untouched; a continued session keeps its own.
	sr = agents.SpawnRequest{}
	if err := d.resolveSubscription(&sr, nil); err != nil || sr.Subscription != work.ID || sr.ConfigDir != subs.Dir(d.opt.DataDir, work.ID) {
		t.Fatalf("default work: %+v %v", sr, err)
	}
	sr = agents.SpawnRequest{Subscription: subs.DefaultID}
	if err := d.resolveSubscription(&sr, nil); err != nil || sr.ConfigDir != "" || sr.Subscription != "" {
		t.Fatalf("own asked for: %+v %v", sr, err)
	}
	sr = agents.SpawnRequest{Agent: "codex"}
	if err := d.resolveSubscription(&sr, nil); err != nil || sr.ConfigDir != "" {
		t.Fatalf("codex: %+v %v", sr, err)
	}
	sr = agents.SpawnRequest{Resume: "x"}
	if err := d.resolveSubscription(&sr, &store.Session{}); err != nil || sr.ConfigDir != "" {
		t.Fatalf("resume on own: %+v %v", sr, err)
	}
	// Gemini has no subscriptions and is not given one.
	sr = agents.SpawnRequest{Agent: "gemini"}
	if err := d.resolveSubscription(&sr, nil); err != nil || sr.ConfigDir != "" || sr.Subscription != "" {
		t.Fatalf("gemini: %+v %v", sr, err)
	}

	// The own sign-in can be renamed, and made the default again.
	name := func(s string) *string { return &s }
	own, err := a.Update(ctx, subs.DefaultID, api.SubscriptionPatch{Agent: "claude", Label: name("Home")})
	if err != nil || own.Label != "Home" || !own.Default || own.Preferred {
		t.Fatalf("rename own: %+v %v", own, err)
	}
	if _, err := a.Update(ctx, subs.DefaultID, api.SubscriptionPatch{Label: name("x")}); err == nil {
		t.Fatal("the own sign-in was renamed without saying whose")
	}
	if _, err := a.Update(ctx, work.ID, api.SubscriptionPatch{Label: name("home")}); err == nil {
		t.Fatal("Work took the own sign-in's name")
	}
	if _, err := a.Update(ctx, work.ID, api.SubscriptionPatch{Label: name("personal")}); err == nil {
		t.Fatal("Work took Personal's name")
	}

	// A plan per subscription; nil clears it; the own one's is the main plan.
	got, err = a.Update(ctx, work.ID, api.SubscriptionPatch{SetPlan: true, Plan: &api.SubscriptionPlan{Kind: "flat", Label: "Max 20×", USDPerMonth: 200}})
	if err != nil || got.Plan == nil || got.Plan.USDPerMonth != 200 || got.Plan.Label != "Max 20×" {
		t.Fatalf("plan: %+v %v", got, err)
	}
	if _, err := a.Update(ctx, subs.DefaultID, api.SubscriptionPatch{Agent: "claude", SetPlan: true, Plan: &api.SubscriptionPlan{Kind: "flat"}}); err == nil {
		t.Fatal("the own sign-in got a second plan")
	}
	got, err = a.Update(ctx, work.ID, api.SubscriptionPatch{SetPlan: true})
	if err != nil || got.Plan != nil {
		t.Fatalf("clear plan: %+v %v", got, err)
	}

	// Removing the default hands it back to the own sign-in.
	if _, err := a.Update(ctx, work.ID, api.SubscriptionPatch{MakeDefault: true}); err != nil {
		t.Fatal(err)
	}
	if err := a.Remove(ctx, work.ID); err != nil {
		t.Fatal(err)
	}
	if got := preferred(); len(got) != 2 || got[0] != "claude:Home" {
		t.Fatalf("after remove: %v", got)
	}
	if d.config().DefaultSubscription != nil {
		t.Fatalf("default kept for a removed subscription: %v", d.config().DefaultSubscription)
	}
}
