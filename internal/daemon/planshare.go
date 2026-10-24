package daemon

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/planshare"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/subs"
)

// planShareTTL is how long GET /v1/plan-share reuses its rates. They are a
// month of spend and a week of limit samples: one turn moves them by a
// rounding error, and computing them is half a second on the owner's
// 2.2 GB database (2026-10-25). Past it the kept answer is still served
// while one refresh runs in the background.
const planShareTTL = 5 * time.Minute

// planShareCache keeps the last rates, with single-flight.
type planShareCache struct {
	mu   sync.Mutex
	at   time.Time
	key  string // the plans the rates were computed for
	resp planshare.Response
	busy chan struct{}
}

// planShareSignIns is every sign-in the plan figures price: the own sign-in
// and each added subscription of Claude Code and Codex, and Claude Code on
// DeepSeek while a key is set.
//
// The main plan (Settings → Plan) is how the user pays for Claude Code, as
// that setting says, so it stands for the own Claude Code sign-in and for an
// added Claude Code subscription with no plan of its own. A Codex sign-in
// has a plan only when one is stated on it: a Claude plan's price says
// nothing about what Codex costs (rule 6).
func planShareSignIns(cfg config.Config) []planshare.SignIn {
	main := planshare.Plan{Kind: cfg.PlanKind, Label: cfg.PlanLabel, USDPerMonth: cfg.PlanUSDPerMonth}
	out := []planshare.SignIn{
		{Agent: subs.AgentClaude, Label: cfg.OwnLabel(subs.AgentClaude), Plan: main, Window: "seven_day"},
	}
	for _, s := range cfg.Subscriptions {
		if s.Agent != subs.AgentClaude {
			continue
		}
		p := main
		if s.Plan != nil {
			p = planshare.Plan{Kind: s.Plan.Kind, Label: s.Plan.Label, USDPerMonth: s.Plan.USDPerMonth}
		}
		out = append(out, planshare.SignIn{Agent: s.Agent, Subscription: s.ID, Label: s.Label, Plan: p, Window: subs.LimitPrefix(s.ID) + "seven_day"})
	}
	if strings.TrimSpace(cfg.DeepSeekAPIKey) != "" {
		out = append(out, planshare.SignIn{Agent: subs.AgentClaude, Subscription: subs.DeepSeekID, Label: "DeepSeek",
			Plan: planshare.Plan{Kind: "metered", Label: "DeepSeek API"}})
	}
	out = append(out, planshare.SignIn{Agent: subs.AgentCodex, Label: cfg.OwnLabel(subs.AgentCodex), Window: store.CodexRateLimitPrefix + "seven_day"})
	for _, s := range cfg.Subscriptions {
		if s.Agent != subs.AgentCodex {
			continue
		}
		var p planshare.Plan
		if s.Plan != nil {
			p = planshare.Plan{Kind: s.Plan.Kind, Label: s.Plan.Label, USDPerMonth: s.Plan.USDPerMonth}
		}
		out = append(out, planshare.SignIn{Agent: s.Agent, Subscription: s.ID, Label: s.Label, Plan: p, Window: subs.LimitPrefix(s.ID) + "seven_day"})
	}
	return out
}

// signInsKey names what the rates depend on in the config, so a plan
// changed in Settings is priced at once rather than after the TTL.
func signInsKey(in []planshare.SignIn) string {
	var b strings.Builder
	for _, s := range in {
		b.WriteString(s.Agent + "|" + s.Subscription + "|" + s.Label + "|" + s.Plan.Kind + "|" + s.Plan.Label + "|" +
			strconv.FormatFloat(s.Plan.USDPerMonth, 'g', -1, 64) + "|" + s.Window + ";")
	}
	return b.String()
}

// planShare is GET /v1/plan-share's answer.
func (d *Daemon) planShare(ctx context.Context) (planshare.Response, error) {
	signIns := planShareSignIns(d.config())
	key := signInsKey(signIns)
	c := &d.planShareC
	for {
		c.mu.Lock()
		fresh := !c.at.IsZero() && c.key == key
		if fresh && time.Since(c.at) < planShareTTL {
			resp := c.resp
			c.mu.Unlock()
			return resp, nil
		}
		if fresh && c.busy == nil {
			// Stale but for the same plans: serve it, refresh behind it.
			resp := c.resp
			done := make(chan struct{})
			c.busy = done
			c.mu.Unlock()
			go func() { _, _ = d.computePlanShare(context.WithoutCancel(ctx), signIns, key, done) }()
			return resp, nil
		}
		if fresh {
			resp := c.resp
			c.mu.Unlock()
			return resp, nil
		}
		if c.busy == nil {
			break
		}
		wait := c.busy
		c.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			return planshare.Response{}, ctx.Err()
		}
	}
	done := make(chan struct{})
	c.busy = done
	c.mu.Unlock()
	return d.computePlanShare(context.WithoutCancel(ctx), signIns, key, done)
}

// computePlanShare computes and keeps the rates, then closes done. An error
// is not kept as an answer; the next caller tries again.
func (d *Daemon) computePlanShare(ctx context.Context, signIns []planshare.SignIn, key string, done chan struct{}) (planshare.Response, error) {
	resp, err := planshare.Compute(ctx, d.store.DB(), signIns, time.Now())
	c := &d.planShareC
	c.mu.Lock()
	if err == nil {
		c.resp, c.at, c.key = resp, time.Now(), key
	}
	c.busy = nil
	c.mu.Unlock()
	close(done)
	return resp, err
}
