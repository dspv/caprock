// Package daemon wires every component into the running `caprock up` process:
// store, pricing, recorder, hookd, ingest, loop detector, API/WS server, the
// idle sweeper, and the runtime.json lifecycle.
package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/hookd"
	"github.com/dspv/caprock/internal/hooks"
	"github.com/dspv/caprock/internal/ingest"
	"github.com/dspv/caprock/internal/loop"
	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// Options configure a daemon run.
type Options struct {
	DataDir        string
	Config         config.Config
	Version        string
	Log            *slog.Logger
	TranscriptRoot string // "" ⇒ ~/.claude/projects
	// Listener overrides the port (tests pass a pre-bound 127.0.0.1:0 listener).
	Listener net.Listener
	// DisableIngest turns transcript tailing off (tests, or hooks-only mode).
	DisableIngest bool
	// IdleAfter is the silence threshold before a session is marked idle.
	IdleAfter time.Duration
	// EndAfter is the silence threshold before a session is marked ended (default 12h).
	EndAfter time.Duration
	// OnReady is called once the server is listening (with the bound URL).
	OnReady func(url string)
}

// Daemon is a running instance.
type Daemon struct {
	opt   Options
	log   *slog.Logger
	store *store.Store
	bus   *bus.Bus
	table *cost.Table
	rec   *rollup.Recorder
	det   *loop.Detector
	tail  *ingest.Tailer
	mgr   *agents.Manager
	api   *api.Server
	rt    config.Runtime
	start time.Time

	mu     sync.Mutex
	alerts map[string]*loop.Alert // session → last alert (expires after window)
	url    string
}

// Run starts the daemon and blocks until ctx is cancelled or a fatal error occurs.
func Run(ctx context.Context, opt Options) error {
	d, err := newDaemon(ctx, opt)
	if err != nil {
		return err
	}
	return d.run(ctx)
}

func newDaemon(ctx context.Context, opt Options) (*Daemon, error) {
	log := opt.Log
	if log == nil {
		log = slog.Default()
	}
	if opt.IdleAfter <= 0 {
		opt.IdleAfter = 5 * time.Minute
	}
	if opt.EndAfter <= 0 {
		opt.EndAfter = 12 * time.Hour
	}
	if opt.DataDir == "" {
		dir, err := config.EnsureDataDir()
		if err != nil {
			return nil, err
		}
		opt.DataDir = dir
	}
	if err := os.MkdirAll(opt.DataDir, 0o700); err != nil {
		return nil, err
	}
	st, err := store.Open(ctx, config.DBPath(opt.DataDir), log)
	if err != nil {
		return nil, fmt.Errorf("open store: %w", err)
	}
	table, err := cost.Load(config.PricingPath(opt.DataDir))
	if err != nil {
		_ = st.Close()
		return nil, err
	}
	// Record the pricing version in force; never rewrite old rows on a bump.
	if prev, _ := st.GetMeta(ctx, store.MetaPricingVersion); prev != table.Version {
		if prev != "" {
			log.Info("pricing table version changed; historical costs are kept as computed", "component", "daemon", "from", prev, "to", table.Version)
		}
		_ = st.SetMeta(ctx, store.MetaPricingVersion, table.Version)
	}
	_ = st.SetMeta(ctx, "transcript_schema_version", strconv.Itoa(ingest.SchemaVersion))

	b := bus.New()
	rec := rollup.New(st, table, b, log)
	det := loop.New(opt.Config.LoopK, time.Duration(opt.Config.LoopTMinutes)*time.Minute)
	d := &Daemon{opt: opt, log: log, store: st, bus: b, table: table, rec: rec, det: det, alerts: map[string]*loop.Alert{}, start: time.Now()}
	return d, nil
}

func (d *Daemon) run(ctx context.Context) error {
	defer d.store.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Listener.
	ln := d.opt.Listener
	if ln == nil {
		var err error
		ln, err = net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(d.opt.Config.Port)))
		if err != nil {
			return fmt.Errorf("listen on 127.0.0.1:%d: %w (is another caprock running? try `caprock status`)", d.opt.Config.Port, err)
		}
	}
	port := ln.Addr().(*net.TCPAddr).Port
	rt, err := config.NewRuntime(port, d.opt.Version)
	if err != nil {
		return err
	}
	d.rt = rt
	if err := config.WriteRuntime(d.opt.DataDir, rt); err != nil {
		return fmt.Errorf("write runtime.json: %w", err)
	}
	defer func() { _ = config.RemoveRuntime(d.opt.DataDir) }()
	d.url = "http://127.0.0.1:" + strconv.Itoa(port)

	// Live-plane subscriber: loop detector over stored events.
	sub := d.bus.Subscribe(4096)
	go d.observeLoops(ctx, sub)

	// Owned-session manager (Phase 1).
	d.mgr = agents.NewManager(d.store, d.opt.DataDir, "", d.log)
	d.mgr.OnExit = func(id string, code int) {
		if s, err := store.GetSession(ctx, d.store.DB(), id); err == nil {
			st, _ := store.GetStats(ctx, d.store.DB(), id)
			d.bus.Publish(bus.Frame{Type: bus.FrameSession, Data: rollup.SessionFrame{Session: s, Stats: st}})
		}
	}

	// Hook receiver.
	hh := &hookd.Handler{Token: rt.Token, Recorder: d.rec, Log: d.log}

	// API.
	d.api = api.New(api.Deps{
		Store: d.store, Bus: d.bus, Table: d.table, Log: d.log, Hook: hh, Version: d.opt.Version,
		Status: d.status, ActiveLoops: d.activeLoop, IdleAfter: d.opt.IdleAfter,
		Token: rt.Token, Shutdown: cancel, Agents: &agentAdapter{m: d.mgr},
	})
	srv := &http.Server{Handler: d.api, ReadHeaderTimeout: 10 * time.Second}

	// Ingest.
	if !d.opt.DisableIngest {
		root := d.opt.TranscriptRoot
		if root == "" {
			r, err := ingest.DefaultRoot()
			if err != nil {
				return err
			}
			root = r
		}
		d.tail = ingest.New(root, d.rec, d.store, d.log)
		go func() {
			if err := d.tail.Run(ctx); err != nil {
				d.log.Error("ingest stopped", "component", "ingest", "err", err)
			}
		}()
	}

	// Idle sweeper (also runs once at start so backfilled history settles immediately).
	_ = d.rec.MarkIdle(ctx, d.opt.IdleAfter, d.opt.EndAfter)
	go d.sweep(ctx)

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	d.log.Info("caprock daemon listening", "component", "daemon", "url", d.url, "data_dir", d.opt.DataDir, "version", d.opt.Version)
	if d.opt.OnReady != nil {
		d.opt.OnReady(d.url)
	}

	select {
	case <-ctx.Done():
	case err := <-errc:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	d.mgr.Shutdown()
	d.api.Close()
	shutdownCtx, c2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer c2()
	_ = srv.Shutdown(shutdownCtx)
	sub.Unsubscribe()
	return nil
}

// URL returns the bound base URL (after start).
func (d *Daemon) URL() string { return d.url }

func (d *Daemon) observeLoops(ctx context.Context, sub *bus.Subscriber) {
	for {
		select {
		case <-ctx.Done():
			return
		case f, ok := <-sub.C:
			if !ok {
				return
			}
			if f.Type != bus.FrameEvent {
				continue
			}
			ev, ok := f.Data.(event.Event)
			if !ok {
				continue
			}
			// Backfilled history must not raise alerts about loops long over.
			if time.Since(ev.Ts) > d.det.Window {
				continue
			}
			if a := d.det.Observe(ev); a != nil {
				d.mu.Lock()
				d.alerts[a.SessionID] = a
				autoPause := d.opt.Config.AutoPause
				d.mu.Unlock()
				d.log.Warn("loop detected", "component", "loop", "session_id", a.SessionID, "tool", a.Tool, "count", a.Count, "sample", a.Sample)
				d.bus.Publish(bus.Frame{Type: bus.FrameAlert, Data: a})
				// Auto-pause is opt-in and OWNED sessions only — we never signal a
				// process we did not start (.ai/05-orchestration.md).
				if autoPause {
					if _, owned := d.mgr.Get(a.SessionID); owned {
						if err := d.mgr.Signal(a.SessionID, ptyman.SignalPause); err == nil {
							d.log.Warn("auto-paused looping owned session", "component", "loop", "session_id", a.SessionID)
							d.bus.Publish(bus.Frame{Type: bus.FrameAlert, Data: map[string]any{"kind": "auto_paused", "session_id": a.SessionID}})
						}
					}
				}
			}
		}
	}
}

// activeLoop returns the session's alert if it is still within the detector window.
func (d *Daemon) activeLoop(sessionID string) *loop.Alert {
	d.mu.Lock()
	defer d.mu.Unlock()
	a := d.alerts[sessionID]
	if a == nil {
		return nil
	}
	if time.Since(a.LastTs) > d.det.Window {
		delete(d.alerts, sessionID)
		return nil
	}
	return a
}

func (d *Daemon) sweep(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := d.rec.MarkIdle(ctx, d.opt.IdleAfter, d.opt.EndAfter); err != nil {
				d.log.Warn("idle sweep", "component", "daemon", "err", err)
			}
		}
	}
}

// Status is /v1/status.
type Status struct {
	Version         string        `json:"version"`
	PID             int           `json:"pid"`
	StartedAt       int64         `json:"started_at"`
	UptimeS         int64         `json:"uptime_s"`
	URL             string        `json:"url"`
	DataDir         string        `json:"data_dir"`
	Pricing         PricingStatus `json:"pricing"`
	Ingest          *ingest.Stats `json:"ingest,omitempty"`
	Hooks           *hooks.Status `json:"hooks,omitempty"`
	UIBuilt         bool          `json:"ui_built"`
	ClaudeAvailable bool          `json:"claude_available"`
	OwnedActive     int           `json:"owned_active"`
	LoopK           int           `json:"loop_k"`
	LoopTMin        int           `json:"loop_t_minutes"`
	ActiveLoops     int           `json:"active_loops"`
}

// PricingStatus summarizes the table in force.
type PricingStatus struct {
	Version      string `json:"version"`
	Source       string `json:"source"`
	FetchedAt    string `json:"fetched_at"`
	UserOverride bool   `json:"user_override"`
	Models       int    `json:"models"`
}

func (d *Daemon) status(_ context.Context) any {
	st := Status{
		Version: d.opt.Version, PID: os.Getpid(), StartedAt: d.start.UnixMilli(), UptimeS: int64(time.Since(d.start).Seconds()),
		URL: d.url, DataDir: d.opt.DataDir, UIBuilt: api.UIBuilt(),
		Pricing: PricingStatus{Version: d.table.Version, Source: d.table.Source, FetchedAt: d.table.FetchedAt, UserOverride: d.table.UserOverride, Models: len(d.table.Models)},
		LoopK:   d.det.K, LoopTMin: int(d.det.Window / time.Minute),
		ClaudeAvailable: d.mgr.ClaudeAvailable(), OwnedActive: len(d.mgr.List()),
	}
	if d.tail != nil {
		s := d.tail.Stats()
		st.Ingest = &s
	}
	if p, err := hooks.DefaultSettingsPath(); err == nil {
		if hs, err := hooks.Inspect(p, config.ShimPath(d.opt.DataDir)); err == nil {
			st.Hooks = &hs
		}
	}
	d.mu.Lock()
	st.ActiveLoops = len(d.alerts)
	d.mu.Unlock()
	return st
}

// agentAdapter bridges *agents.Manager to api.AgentController.
type agentAdapter struct{ m *agents.Manager }

func (a *agentAdapter) Available() bool { return a.m.ClaudeAvailable() }

func (a *agentAdapter) Spawn(ctx context.Context, req any) (string, string, error) {
	b, err := json.Marshal(req)
	if err != nil {
		return "", "", err
	}
	var sr agents.SpawnRequest
	if err := json.Unmarshal(b, &sr); err != nil {
		return "", "", err
	}
	ag, err := a.m.Spawn(ctx, sr)
	if err != nil {
		return "", "", err
	}
	return ag.SessionID, ag.Cwd, nil
}

func (a *agentAdapter) Input(id string, data []byte) error     { return a.m.Input(id, data) }
func (a *agentAdapter) Write(id string, data []byte) error     { return a.m.Input(id, data) }
func (a *agentAdapter) Resize(id string, cols, rows int) error { return a.m.Resize(id, cols, rows) }

func (a *agentAdapter) Signal(id, action string) error {
	return a.m.Signal(id, ptyman.Signal(action))
}

func (a *agentAdapter) Term(id string) ([]byte, <-chan []byte, func(), bool) {
	ag, ok := a.m.Get(id)
	if !ok {
		return nil, nil, nil, false
	}
	sub, cancel := ag.Subscribe()
	return ag.Snapshot(), sub, cancel, true
}
