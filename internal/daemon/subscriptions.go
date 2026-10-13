package daemon

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/codex"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/hooks"
	"github.com/dspv/caprock/internal/ingest"
	"github.com/dspv/caprock/internal/license"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/subs"
	"github.com/dspv/caprock/internal/userenv"
)

// Settings → Subscriptions (ADR-048). A subscription is a sign-in to Claude
// Code or Codex kept in <data dir>/profiles/<id>/; a session started on it
// gets CLAUDE_CONFIG_DIR or CODEX_HOME pointing there. The daemon prepares
// the directory, reads the transcripts the agent writes into it, and files
// its sessions and plan windows under the subscription. It never signs in,
// never runs the agent to ask, and never moves a running session.

// subIngest holds one reader per subscription directory, so adding a
// subscription starts watching it and removing one stops.
type subIngest struct {
	mu      sync.Mutex
	running map[string]context.CancelFunc
}

// startSubIngest begins reading sub's directory, once.
func (d *Daemon) startSubIngest(sub config.Subscription) {
	if d.opt.DisableIngest || d.baseCtx == nil {
		return
	}
	d.subIn.mu.Lock()
	defer d.subIn.mu.Unlock()
	if d.subIn.running == nil {
		d.subIn.running = map[string]context.CancelFunc{}
	}
	if _, ok := d.subIn.running[sub.ID]; ok {
		return
	}
	ctx, cancel := context.WithCancel(d.baseCtx)
	d.subIn.running[sub.ID] = cancel
	dir := subs.Dir(d.opt.DataDir, sub.ID)
	switch sub.Agent {
	case subs.AgentClaude:
		// The transcripts are under the directory's projects/, exactly as
		// they are under ~/.claude/projects for the Default sign-in; the
		// recorder files them under the subscription by their path.
		t := ingest.New(filepath.Join(dir, "projects"), d.rec, d.store, d.log)
		go func() {
			if err := t.Run(ctx); err != nil && ctx.Err() == nil {
				d.log.Warn("subscription transcripts stopped", "component", "subs", "subscription", sub.ID, "err", err)
			}
		}()
	case subs.AgentCodex:
		in := codex.NewIngester([]string{filepath.Join(dir, "sessions"), filepath.Join(dir, "archived_sessions")}, d.rec, d.log, 5*time.Second)
		in.Link = d.link
		in.Subscription = sub.ID
		in.LimitPrefix = subs.LimitPrefix(sub.ID)
		go func() {
			if err := in.Run(ctx); err != nil && ctx.Err() == nil {
				d.log.Warn("subscription codex import stopped", "component", "subs", "subscription", sub.ID, "err", err)
			}
		}()
	}
}

func (d *Daemon) stopSubIngest(id string) {
	d.subIn.mu.Lock()
	defer d.subIn.mu.Unlock()
	if cancel, ok := d.subIn.running[id]; ok {
		cancel()
		delete(d.subIn.running, id)
	}
}

// prepareSub (re)writes what a subscription's directory needs: for Claude
// Code, Caprock's hooks and status line (subs.Prepare).
func (d *Daemon) prepareSub(sub config.Subscription) error {
	shim, statusline, defSettings := "", "", ""
	if sub.Agent == subs.AgentClaude {
		if err := hooks.EnsureShim(d.opt.DataDir); err != nil {
			d.log.Warn("hook shim", "component", "subs", "err", err)
		}
		shim = hooks.ShimCommand(d.opt.DataDir)
		// Settings → Status line: Off keeps it out of every sign-in.
		if self, err := os.Executable(); err == nil && config.StatuslineRegistered(d.config().StatuslineMode) {
			statusline = hooks.ShellCommand(self) + " statusline"
		}
		defSettings, _ = hooks.DefaultSettingsPath()
	}
	return subs.Prepare(sub.Agent, subs.Dir(d.opt.DataDir, sub.ID), shim, statusline, defSettings)
}

// startSubscriptions prepares and watches every subscription at start-up:
// a new version may have moved the shim, and the hooks must follow it.
func (d *Daemon) startSubscriptions() {
	for _, sub := range d.config().Subscriptions {
		if err := d.prepareSub(sub); err != nil {
			d.log.Warn("could not prepare a subscription", "component", "subs", "subscription", sub.ID, "err", err)
		}
		d.startSubIngest(sub)
	}
}

// resolveSubscription turns a spawn request's subscription into the
// directory the session runs with. A continued session runs on the one it
// ran on, whatever the request said: its conversation is in that
// directory and nowhere else. A request that names none gets the one made
// the default in Settings → Subscriptions; "default" is the user's own
// sign-in, whichever is the default.
func (d *Daemon) resolveSubscription(sr *agents.SpawnRequest, prev *store.Session) error {
	agent := sr.Agent
	if agent == "" {
		agent = agents.AgentClaude
	}
	id := sr.Subscription
	switch {
	case prev != nil:
		id = prev.Subscription
	case id == "" && subs.Supported(agent):
		id = d.config().DefaultSubscriptionFor(agent)
	}
	if id == "" || id == subs.DefaultID {
		sr.Subscription, sr.ConfigDir = "", ""
		return nil
	}
	sr.Subscription = id
	if id == subs.DeepSeekID {
		return resolveDeepSeek(sr, agent, d.config().DeepSeekAPIKey, prev != nil)
	}
	sub, ok := subs.Find(d.config().Subscriptions, id)
	if !ok {
		if prev != nil {
			return fmt.Errorf("this session ran on a subscription that has been removed; add it again in Settings → Subscriptions to continue it")
		}
		return fmt.Errorf("no subscription %q; see Settings → Subscriptions", id)
	}
	if sub.Agent != agent {
		return fmt.Errorf("%s is a %s subscription, not %s", sub.Label, agentName(sub.Agent), agentName(agent))
	}
	if err := d.prepareSub(sub); err != nil {
		return fmt.Errorf("prepare %s: %w", sub.Label, err)
	}
	d.startSubIngest(sub)
	sr.ConfigDir = subs.Dir(d.opt.DataDir, sub.ID)
	return nil
}

// resolveDeepSeek fills in a Claude Code session on DeepSeek: the user's own
// configuration directory (none is set), and the key from the daemon's
// settings — never from the request.
func resolveDeepSeek(sr *agents.SpawnRequest, agent, key string, resumed bool) error {
	if agent != agents.AgentClaude {
		return fmt.Errorf("DeepSeek runs Claude Code sessions, not %s", agentName(agent))
	}
	if strings.TrimSpace(key) == "" {
		if resumed {
			return fmt.Errorf("this session ran on DeepSeek and no DeepSeek key is set; add it in Settings → Subscriptions to continue it")
		}
		return fmt.Errorf("no DeepSeek key is set; add it in Settings → Subscriptions")
	}
	sr.ConfigDir = ""
	sr.DeepSeekKey = strings.TrimSpace(key)
	// The launcher's model list is Claude's. A Claude id sent to DeepSeek is
	// mapped by DeepSeek to a model of its choosing (claude-opus* to
	// deepseek-v4-pro, the rest to deepseek-flash), so it is dropped and the
	// session runs on the model the environment names (agents.DeepSeekModel).
	if !strings.HasPrefix(strings.ToLower(sr.Model), "deepseek-") {
		sr.Model = ""
	}
	return nil
}

func agentName(agent string) string {
	if agent == subs.AgentCodex {
		return "Codex"
	}
	if agent == subs.AgentClaude {
		return "Claude Code"
	}
	return agent
}

// subsAdapter is api.SubscriptionManager.
type subsAdapter struct{ d *Daemon }

func (a *subsAdapter) licensed() bool {
	return license.Parse(a.d.config().LicenseKey, time.Now()).Active
}

func (a *subsAdapter) List(ctx context.Context) (api.SubscriptionsResponse, error) {
	d := a.d
	cfg := d.config()
	home, _ := os.UserHomeDir()
	env := userenv.Cached()
	getenv := func(k string) string {
		for i := len(env) - 1; i >= 0; i-- {
			if v, ok := strings.CutPrefix(env[i], k+"="); ok {
				return v
			}
		}
		return ""
	}
	spend := map[string]store.SubscriptionSpend{}
	if rows, err := store.SpendBySubscription(ctx, d.store.DB(), time.Now().Add(-7*24*time.Hour).UnixMilli()); err == nil {
		for _, r := range rows {
			spend[r.Agent+"|"+r.Subscription] = r
		}
	}
	running := a.runningBySubscription(ctx)
	out := api.SubscriptionsResponse{Licensed: a.licensed(), FreePerAgent: subs.FreePerAgent, Home: home}
	for _, agent := range []string{subs.AgentClaude, subs.AgentCodex} {
		g := api.SubscriptionAgent{Agent: agent, Label: agentName(agent), Installed: d.mgr != nil && d.mgr.AgentAvailable(agent), Subscriptions: []api.Subscription{}}
		dp := subs.DefaultPaths(agent, home, getenv)
		preferred := cfg.DefaultSubscriptionFor(agent)
		def := a.view(ctx, config.Subscription{ID: "", Label: cfg.OwnLabel(agent), Agent: agent}, dp, spend, running)
		def.Preferred = preferred == ""
		g.Subscriptions = append(g.Subscriptions, def)
		for _, s := range cfg.Subscriptions {
			if s.Agent != agent {
				continue
			}
			v := a.view(ctx, s, subs.ProfilePaths(agent, subs.Dir(d.opt.DataDir, s.ID)), spend, running)
			v.Preferred = preferred == s.ID
			g.Subscriptions = append(g.Subscriptions, v)
		}
		if agent == subs.AgentClaude && strings.TrimSpace(cfg.DeepSeekAPIKey) != "" {
			g.Subscriptions = append(g.Subscriptions, deepSeekView(spend, running))
		}
		out.Agents = append(out.Agents, g)
	}
	return out, nil
}

// deepSeekView is Claude Code on DeepSeek as the pickers show it: ready
// whenever a key is set, billed per token by DeepSeek, and with no plan
// windows — a Claude plan's limits say nothing about it.
func deepSeekView(spend map[string]store.SubscriptionSpend, running map[string]int) api.Subscription {
	v := api.Subscription{
		ID: subs.DeepSeekID, Agent: subs.AgentClaude, Label: "DeepSeek", Provider: subs.DeepSeekID,
		SignedIn: true, Account: "your DeepSeek API key",
		Plan:    &api.SubscriptionPlan{Kind: "metered", Label: "DeepSeek API"},
		Windows: []api.SubscriptionWindow{},
	}
	if s, ok := spend[subs.AgentClaude+"|"+subs.DeepSeekID]; ok {
		v.Sessions7d, v.Cost7dUSD = s.Sessions, s.CostUSD
	}
	v.Running = running[subs.AgentClaude+"|"+subs.DeepSeekID]
	return v
}

// view is one subscription as the page shows it. sub.ID "" is the Default.
func (a *subsAdapter) view(ctx context.Context, sub config.Subscription, p subs.Paths, spend map[string]store.SubscriptionSpend, running map[string]int) api.Subscription {
	v := api.Subscription{
		ID: sub.ID, Agent: sub.Agent, Label: sub.Label, Default: sub.ID == "", Dir: p.Dir, CreatedAt: sub.CreatedAt,
		Windows: []api.SubscriptionWindow{},
	}
	if v.Default {
		v.ID = subs.DefaultID
		v.LoginCommand = subs.LoginCommandHere(sub.Agent, "")
	} else {
		v.EnvVar = subs.EnvVar(sub.Agent)
		v.LoginCommand = subs.LoginCommandHere(sub.Agent, p.Dir)
	}
	si := subs.Status(p)
	v.SignedIn, v.Account = si.SignedIn, si.Account
	v.Windows = a.windows(ctx, sub)
	// Plan windows only arrive from a session that ran signed in: they are
	// evidence of a sign-in even where the files say nothing (a Codex kept
	// in the OS keyring).
	if !v.SignedIn && len(v.Windows) > 0 {
		v.SignedIn = true
	}
	if s, ok := spend[sub.Agent+"|"+sub.ID]; ok {
		v.Sessions7d, v.Cost7dUSD = s.Sessions, s.CostUSD
	}
	v.Running = running[sub.Agent+"|"+sub.ID]
	if sub.Plan != nil {
		v.Plan = &api.SubscriptionPlan{Kind: sub.Plan.Kind, Label: sub.Plan.Label, USDPerMonth: sub.Plan.USDPerMonth}
	}
	return v
}

// windows reads a subscription's plan windows from where they are stored:
// the Default sign-in's under the keys they always had, a subscription's
// under its own prefix.
func (a *subsAdapter) windows(ctx context.Context, sub config.Subscription) []api.SubscriptionWindow {
	db := a.d.store.DB()
	var snaps []store.RateLimitSnapshot
	switch {
	case sub.ID != "":
		snaps, _ = store.RateLimitsWithPrefix(ctx, db, subs.LimitPrefix(sub.ID))
	case sub.Agent == subs.AgentCodex:
		snaps, _ = store.RateLimitsWithPrefix(ctx, db, store.CodexRateLimitPrefix)
	default:
		for _, w := range []string{"five_hour", "seven_day"} {
			if s, ok, err := store.LatestRateLimit(ctx, db, w); err == nil && ok {
				s.Window = w
				snaps = append(snaps, s)
			}
		}
	}
	out := []api.SubscriptionWindow{}
	for _, s := range snaps {
		if s.Window != "five_hour" && s.Window != "seven_day" {
			continue
		}
		out = append(out, api.SubscriptionWindow{Window: s.Window, UsedPercentage: s.UsedPercentage, ResetsAt: s.ResetsAt, ObservedAt: s.Ts})
	}
	slices.SortFunc(out, func(x, y api.SubscriptionWindow) int { return strings.Compare(x.Window, y.Window) })
	return out
}

// runningBySubscription counts the sessions Caprock started that are running,
// by "agent|subscription".
func (a *subsAdapter) runningBySubscription(ctx context.Context) map[string]int {
	out := map[string]int{}
	if a.d.mgr == nil {
		return out
	}
	for _, id := range a.d.mgr.OwnedRunning() {
		s, err := store.GetSession(ctx, a.d.store.DB(), id)
		if err != nil {
			continue
		}
		agent := s.Agent
		if agent == "" {
			agent = subs.AgentClaude
		}
		out[agent+"|"+s.Subscription]++
	}
	return out
}

func (a *subsAdapter) Add(ctx context.Context, agent, label string) (api.Subscription, error) {
	d := a.d
	if !subs.Supported(agent) {
		return api.Subscription{}, fmt.Errorf("subscriptions are for claude and codex, not %q", agent)
	}
	label, err := subs.CleanLabel(label)
	if err != nil {
		return api.Subscription{}, err
	}
	id, err := subs.NewID()
	if err != nil {
		return api.Subscription{}, err
	}
	sub := config.Subscription{ID: id, Label: label, Agent: agent, CreatedAt: time.Now().UnixMilli()}
	d.cfgMu.Lock()
	cfg := d.opt.Config
	if subs.Count(cfg.Subscriptions, agent) >= subs.FreePerAgent && !license.Parse(cfg.LicenseKey, time.Now()).Active {
		d.cfgMu.Unlock()
		return api.Subscription{}, api.ErrSubscriptionPremium
	}
	for _, s := range cfg.Subscriptions {
		if s.Agent == agent && strings.EqualFold(s.Label, label) {
			d.cfgMu.Unlock()
			return api.Subscription{}, fmt.Errorf("there is already a %s subscription called %s", agentName(agent), s.Label)
		}
	}
	if strings.EqualFold(label, "Default") || strings.EqualFold(label, cfg.OwnLabel(agent)) {
		d.cfgMu.Unlock()
		return api.Subscription{}, fmt.Errorf("pick a name other than %s", label)
	}
	next := slices.Clone(cfg.Subscriptions)
	next = append(next, sub)
	d.opt.Config.Subscriptions = next
	cfg = d.opt.Config
	d.cfgMu.Unlock()
	if err := config.Save(d.opt.DataDir, cfg); err != nil {
		return api.Subscription{}, err
	}
	if err := d.prepareSub(sub); err != nil {
		return api.Subscription{}, fmt.Errorf("prepare the directory: %w", err)
	}
	d.startSubIngest(sub)
	d.log.Info("added a subscription", "component", "subs", "subscription", id, "agent", agent)
	return a.view(ctx, sub, subs.ProfilePaths(agent, subs.Dir(d.opt.DataDir, id)), nil, nil), nil
}

// Update renames a subscription, makes it the one new sessions of its agent
// start on, or sets its plan. id "default" is the user's own sign-in to
// p.Agent: it can be renamed and made the default again; its plan is the
// main one in /v1/settings. Nothing here touches a directory, a credential
// or a running session: the default is which directory Caprock gives the
// sessions it starts next.
func (a *subsAdapter) Update(ctx context.Context, id string, p api.SubscriptionPatch) (api.Subscription, error) {
	d := a.d
	var label string
	if p.Label != nil {
		l, err := subs.CleanLabel(*p.Label)
		if err != nil {
			return api.Subscription{}, err
		}
		if strings.EqualFold(l, "Default") {
			return api.Subscription{}, errors.New("pick a name other than Default: it is what the one new sessions start on is marked")
		}
		label = l
	}
	own := id == subs.DefaultID
	if own && !subs.Supported(p.Agent) {
		return api.Subscription{}, errors.New(`say whose own sign-in: "agent" is "claude" or "codex"`)
	}
	if own && p.SetPlan {
		return api.Subscription{}, errors.New("your own sign-in's plan is the main plan: set it in Settings → Plan & licence")
	}
	d.cfgMu.Lock()
	cfg := d.opt.Config
	agent := p.Agent
	i := -1
	if !own {
		i = slices.IndexFunc(cfg.Subscriptions, func(s config.Subscription) bool { return s.ID == id })
		if i < 0 {
			d.cfgMu.Unlock()
			return api.Subscription{}, api.ErrSubscriptionNotFound
		}
		agent = cfg.Subscriptions[i].Agent
	}
	if label != "" {
		for _, s := range cfg.Subscriptions {
			if s.Agent == agent && s.ID != id && strings.EqualFold(s.Label, label) {
				d.cfgMu.Unlock()
				return api.Subscription{}, fmt.Errorf("there is already a %s subscription called %s", agentName(agent), s.Label)
			}
		}
		if !own && strings.EqualFold(cfg.OwnLabel(agent), label) {
			d.cfgMu.Unlock()
			return api.Subscription{}, fmt.Errorf("your own %s sign-in is already called %s", agentName(agent), cfg.OwnLabel(agent))
		}
	}
	next := slices.Clone(cfg.Subscriptions)
	if i >= 0 {
		if label != "" {
			next[i].Label = label
		}
		if p.SetPlan {
			if p.Plan == nil {
				next[i].Plan = nil
			} else {
				next[i].Plan = &config.Plan{Kind: p.Plan.Kind, Label: p.Plan.Label, USDPerMonth: p.Plan.USDPerMonth}
			}
		}
	}
	d.opt.Config.Subscriptions = next
	if own && label != "" {
		labels := maps.Clone(cfg.OwnLabels)
		if labels == nil {
			labels = map[string]string{}
		}
		labels[agent] = label
		d.opt.Config.OwnLabels = labels
	}
	if p.MakeDefault {
		def := maps.Clone(cfg.DefaultSubscription)
		if def == nil {
			def = map[string]string{}
		}
		if own {
			delete(def, agent)
		} else {
			def[agent] = id
		}
		if len(def) == 0 {
			def = nil
		}
		d.opt.Config.DefaultSubscription = def
	}
	cfg = d.opt.Config
	d.cfgMu.Unlock()
	if err := config.Save(d.opt.DataDir, cfg); err != nil {
		return api.Subscription{}, err
	}
	if p.MakeDefault {
		d.log.Info("new sessions start on another subscription", "component", "subs", "agent", agent, "subscription", id)
	}
	list, err := a.List(ctx)
	if err != nil {
		return api.Subscription{}, err
	}
	for _, g := range list.Agents {
		for _, s := range g.Subscriptions {
			if s.Agent == agent && s.ID == id {
				return s, nil
			}
		}
	}
	return api.Subscription{}, api.ErrSubscriptionNotFound
}

// Remove forgets a subscription and deletes its directory — Caprock's own,
// with the sign-in, history and settings the agent kept there. Refused while
// a session Caprock started runs on it: its agent is reading that directory.
// The sessions already recorded keep the id, and say the subscription was
// removed.
func (a *subsAdapter) Remove(ctx context.Context, id string) error {
	d := a.d
	sub, ok := subs.Find(d.config().Subscriptions, id)
	if !ok {
		return api.ErrSubscriptionNotFound
	}
	if a.runningBySubscription(ctx)[sub.Agent+"|"+id] > 0 {
		return api.ErrSubscriptionInUse
	}
	d.cfgMu.Lock()
	d.opt.Config.Subscriptions = slices.DeleteFunc(slices.Clone(d.opt.Config.Subscriptions), func(s config.Subscription) bool { return s.ID == id })
	// The default goes back to the user's own sign-in with it.
	if d.opt.Config.DefaultSubscription[sub.Agent] == id {
		def := maps.Clone(d.opt.Config.DefaultSubscription)
		delete(def, sub.Agent)
		if len(def) == 0 {
			def = nil
		}
		d.opt.Config.DefaultSubscription = def
	}
	cfg := d.opt.Config
	d.cfgMu.Unlock()
	if err := config.Save(d.opt.DataDir, cfg); err != nil {
		return err
	}
	d.stopSubIngest(id)
	if err := subs.Remove(d.opt.DataDir, id); err != nil {
		return fmt.Errorf("removed from the list, but its folder is still there: %w", err)
	}
	d.log.Info("removed a subscription", "component", "subs", "subscription", id)
	return nil
}

// defaultSubSessions is the slice of the session manager the plan-window stop
// may use, narrowed to the Default sign-in: the windows it watches are that
// sign-in's, so a session on another subscription is not its to pause.
type defaultSubSessions struct{ d *Daemon }

func (s defaultSubSessions) PauseOwned(id string) (bool, error)  { return s.d.mgr.PauseOwned(id) }
func (s defaultSubSessions) ResumeOwned(id string) (bool, error) { return s.d.mgr.ResumeOwned(id) }
func (s defaultSubSessions) OwnedRunningKind(kind string) []string {
	ids := s.d.mgr.OwnedRunningKind(kind)
	out := ids[:0:0]
	for _, id := range ids {
		if sess, err := store.GetSession(context.Background(), s.d.store.DB(), id); err == nil && sess.Subscription != "" {
			continue
		}
		out = append(out, id)
	}
	return out
}

// applyStatuslineMode registers or removes Caprock's own statusLine entry to
// match Settings → Status line: in the user's own Claude Code settings and
// in each Claude Code subscription's directory. Ownership is the hooks
// package's (SetStatuslineOn): a statusLine the user set is never replaced
// or removed. A failure is logged, not returned — the choice is saved and
// takes effect on the line itself at the next render either way.
func (d *Daemon) applyStatuslineMode(cfg config.Config) {
	self, err := os.Executable()
	if err != nil {
		d.log.Warn("status line: no executable path", "component", "statusline", "err", err)
		return
	}
	cmd := hooks.ShellCommand(self) + " statusline"
	on := config.StatuslineRegistered(cfg.StatuslineMode)
	var paths []string
	if sp, err := hooks.DefaultSettingsPath(); err == nil {
		paths = append(paths, sp)
	}
	for _, sub := range cfg.Subscriptions {
		if sub.Agent == subs.AgentClaude {
			paths = append(paths, filepath.Join(subs.Dir(d.opt.DataDir, sub.ID), "settings.json"))
		}
	}
	for _, sp := range paths {
		if changed, err := hooks.SetStatuslineOn(sp, cmd, on); err != nil {
			d.log.Warn("status line not applied", "component", "statusline", "settings", sp, "err", err)
		} else if changed {
			d.log.Info("status line applied", "component", "statusline", "settings", sp, "on", on)
		}
	}
}
