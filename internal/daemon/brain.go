package daemon

import (
	"context"
	"path/filepath"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/brain"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/userenv"
)

// newBrain builds Second Brain's automatic extraction (ADR-063). It reads
// through whichever of the user's coding agents is chosen, or the one used
// most (ADR-103) — claude, codex, cursor-agent or gemini, found the way the
// launcher finds them — with the user's login-shell environment, from a
// folder of its own under the data directory; it runs only once the user
// has turned it on; no licence is needed.
func (d *Daemon) newBrain() *brain.Engine {
	env := func() []string { return userenv.Environ(d.log) }
	bin := func(agent string) func() string { return func() string { return d.mgr.AgentBinary(agent) } }
	run := filepath.Join(d.opt.DataDir, "brain", "run")
	claude := brain.ClaudeRunner{Binary: d.mgr.ClaudeBinary, Env: env, Dir: run}
	return &brain.Engine{
		Store: d.store, Bus: d.bus, Log: d.log,
		Config:      func() config.BrainConfig { return d.config().Brain },
		ClaudeFound: func() bool { return d.mgr.ClaudeBinary() != "" },
		HandoffOn:   func() bool { return d.config().MemoryOn() },
		Runner:      claude,
		Readers: map[string]brain.Runner{
			brain.ReaderClaude: claude,
			brain.ReaderCodex:  brain.CodexRunner{Binary: bin(agents.AgentCodex), Env: env, Dir: filepath.Join(run, "codex")},
			brain.ReaderCursor: &brain.CursorRunner{Binary: bin(agents.AgentCursor), Env: env, Dir: filepath.Join(run, "cursor")},
			brain.ReaderGemini: brain.GeminiRunner{Binary: bin(agents.AgentGemini), Env: env, Dir: filepath.Join(run, "gemini")},
		},
		Installed: func(agent string) bool { return d.mgr.AgentBinary(agent) != "" },
	}
}

// newTLDRRunner is what AI;DR squeezes one answer with (ADR-072): the same
// headless call to the user's own claude as Second Brain's, from a folder of
// its own beside it, bounded to a minute.
func (d *Daemon) newTLDRRunner() brain.Runner {
	return brain.ClaudeRunner{
		Binary:  d.mgr.ClaudeBinary,
		Env:     func() []string { return userenv.Environ(d.log) },
		Dir:     filepath.Join(d.opt.DataDir, "brain", "tldr"),
		Timeout: time.Minute,
	}
}

// brainAdapter is api.BrainAuto over the engine and the saved settings.
type brainAdapter struct {
	d   *Daemon
	eng *brain.Engine
}

func (b *brainAdapter) Status(ctx context.Context) any { return b.eng.Status(ctx) }

func (b *brainAdapter) DailyTokens() int64 { return b.eng.DailyTokens() }

func (b *brainAdapter) Configure(_ context.Context, set api.BrainSettings) error {
	d := b.d
	d.cfgMu.Lock()
	c := &d.opt.Config.Brain
	turnedOn := false
	if set.Auto != nil {
		was := c.Auto != nil && *c.Auto
		v := *set.Auto
		c.Auto = &v
		// Reading starts from the moment of the yes: the sessions before it
		// are read only when a backfill asks for them.
		if v && !was {
			c.Since = time.Now().UnixMilli()
			turnedOn = true
		}
	}
	if set.DailyTokens != nil {
		c.DailyTokens = *set.DailyTokens
	}
	if set.Model != nil {
		c.Model = *set.Model
	}
	if set.Reader != nil {
		c.Reader = *set.Reader
		if c.Reader == brain.ReaderAuto {
			c.Reader = ""
		}
	}
	if set.Models != nil {
		// A copy, so the config already handed out is never written under it.
		m := make(map[string]string, len(c.Models)+len(*set.Models))
		for k, v := range c.Models {
			m[k] = v
		}
		for k, v := range *set.Models {
			if v == "" {
				delete(m, k)
			} else {
				m[k] = v
			}
		}
		if len(m) == 0 {
			m = nil
		}
		c.Models = m
	}
	if set.DailyReads != nil {
		c.DailyReads = *set.DailyReads
	}
	if set.Exclude != nil {
		c.Exclude = *set.Exclude
	}
	cfg := d.opt.Config
	d.cfgMu.Unlock()
	if err := config.Save(d.opt.DataDir, cfg); err != nil {
		return err
	}
	if turnedOn {
		b.eng.Kick()
	}
	return nil
}

func (b *brainAdapter) ExcludedProjects() []string {
	return brain.ExcludedProjects(b.d.config().Brain.Exclude)
}

// brainExcludedFolder is whether a folder is one the user excluded from
// Second Brain: a session there is handed none of its memories.
func (d *Daemon) brainExcludedFolder(cwd string) bool {
	_, ok := brain.ExcludedFolder(d.config().Brain.Exclude, cwd, "")
	return ok
}

func (b *brainAdapter) Estimate(ctx context.Context, days int) (any, error) {
	return b.eng.EstimateFrom(ctx, time.Now().Add(-time.Duration(days)*24*time.Hour).UnixMilli())
}

func (b *brainAdapter) Backfill(_ context.Context, days int) error {
	d := b.d
	d.cfgMu.Lock()
	c := &d.opt.Config.Brain
	if c.Auto == nil || !*c.Auto {
		d.cfgMu.Unlock()
		return api.ErrBrainAutoOff
	}
	c.BackfillSince = time.Now().Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
	cfg := d.opt.Config
	d.cfgMu.Unlock()
	if err := config.Save(d.opt.DataDir, cfg); err != nil {
		return err
	}
	b.eng.Kick()
	return nil
}
