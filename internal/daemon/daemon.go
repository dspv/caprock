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
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/board"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/desktop"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/hive"
	"github.com/dspv/caprock/internal/hookd"
	"github.com/dspv/caprock/internal/hooks"
	"github.com/dspv/caprock/internal/ingest"
	"github.com/dspv/caprock/internal/loop"
	"github.com/dspv/caprock/internal/opencode"
	"github.com/dspv/caprock/internal/orchestrator"
	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/update"
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
	// OpenCodeURL overrides where OpenCode's headless server is expected.
	// Empty means the documented default; tests point it at a stub.
	OpenCodeURL string
	// OpenCodeDB overrides where OpenCode's database is looked for. Empty means
	// discover it; "off" disables the reader entirely. Tests must set one or
	// the other, or a developer's own OpenCode sessions leak into a temporary
	// store and make assertions about session counts fail on their machine and
	// pass in CI.
	OpenCodeDB string
	// IdleAfter is the silence threshold before a session is marked idle.
	IdleAfter time.Duration
	// EndAfter is the silence threshold before a session is marked ended (default 12h).
	EndAfter time.Duration
	// HiveDir enables Phase 2 orchestration (tasks board + Stop-loop) at this path.
	// Empty ⇒ orchestration off (task endpoints return 501).
	HiveDir string
	// RepoCwd is the repo the orchestrator + workers operate on (default: cwd).
	RepoCwd string
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
	ocIn  *opencode.Ingester
	mgr   *agents.Manager
	board *board.Board
	orch  *orchestrator.Orchestrator
	api   *api.Server
	rt    config.Runtime
	start time.Time

	// cfgMu guards opt.Config, which the settings endpoint mutates at runtime.
	cfgMu sync.RWMutex
	// hiveMu guards board, orch and opt.HiveDir/opt.RepoCwd. The task runner can
	// be turned on after startup (POST /v1/hive), so these are written from a
	// request goroutine while the API, the hook receiver and /v1/status read them.
	hiveMu sync.RWMutex
	// upd checks for newer releases; only ever used when the user opted in.
	upd *update.Checker
	// baseCtx is the daemon-lifetime context (not a request's).
	baseCtx context.Context

	mu     sync.Mutex
	alerts map[string]*loop.Alert // session → last alert (expires after window)
	url    string
	// ingestErr is the terminal error from the tailer goroutine, if it died.
	// Ingest is the whole product on Phase 0, so its death is not a log line:
	// it is reported by /v1/status, `caprock status` and the dashboard.
	ingestErr error
}

// setIngestErr records the terminal ingest error for /v1/status.
func (d *Daemon) setIngestErr(err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ingestErr = err
}

// ingestError returns the terminal ingest error, or nil while ingest is alive.
func (d *Daemon) ingestError() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.ingestErr
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
	// Parser v1 clipped assistant prose on byte boundaries, which cut multi-byte
	// text at roughly half the intended length and corrupted the tail. Re-derive
	// the affected rows from the transcripts once, then record the new version.
	// Best-effort: a failed repair must never stop the daemon from starting.
	prevSchema, _ := st.GetMeta(ctx, store.MetaTranscriptSchema)
	if ingest.NeedsTextRepair(prevSchema) {
		if n, err := ingest.RepairAssistantText(ctx, st.DB(), log); err != nil {
			log.Warn("could not repair truncated assistant text", "component", "ingest", "err", err)
		} else if n > 0 {
			log.Info("repaired truncated assistant text", "component", "ingest", "events", n, "from_schema", prevSchema)
		}
	}
	_ = st.SetMeta(ctx, store.MetaTranscriptSchema, strconv.Itoa(ingest.SchemaVersion))
	b := bus.New()
	rec := rollup.New(st, table, b, log)
	det := loop.New(opt.Config.LoopK, time.Duration(opt.Config.LoopTMinutes)*time.Minute)
	d := &Daemon{opt: opt, log: log, store: st, bus: b, table: table, rec: rec, det: det, alerts: map[string]*loop.Alert{}, start: time.Now(), upd: update.New()}
	return d, nil
}

func (d *Daemon) run(ctx context.Context) error {
	defer d.store.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	d.baseCtx = ctx

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

	// Phase 2 board (opt-in via HiveDir, or turned on later over the API).
	if d.opt.HiveDir != "" {
		if err := d.enableHive(ctx, d.opt.HiveDir, d.opt.RepoCwd); err != nil {
			return err
		}
	}

	// Hook receiver. Decide is wired unconditionally: it is a method that
	// answers nil while no board exists, so the Stop-loop starts working the
	// moment the task runner is turned on rather than only on the next restart.
	hh := &hookd.Handler{Token: rt.Token, Recorder: d.rec, Log: d.log, Decide: d.stopDecision}

	// API.
	d.api = api.New(api.Deps{
		Store: d.store, Bus: d.bus, Table: d.table, Log: d.log, Hook: hh, Version: d.opt.Version,
		Status: d.status, ActiveLoops: d.activeLoop, IdleAfter: d.opt.IdleAfter,
		Token: rt.Token, Shutdown: cancel, Agents: &agentAdapter{m: d.mgr},
		Tasks: &boardAdapter{d: d}, Settings: &settingsAdapter{d: d}, Update: d.upd,
		DataDir: d.opt.DataDir,
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
				// Logging alone made a fatal ingest failure invisible: with a
				// read-only ~/.claude the daemon reported healthy, `caprock
				// status` said "backfill done", and the dashboard showed "No
				// sessions yet — start claude in any terminal" forever. Store it
				// so /v1/status, the CLI and the Now screen can all say so.
				if ctx.Err() == nil {
					d.setIngestErr(err)
				}
			}
		}()
	}

	// OpenCode, when this machine has it. A second coding agent keeps its own
	// SQLite database with cost and tokens already computed, so the daemon
	// reads it directly rather than installing anything. Its absence is the
	// normal case and is silent: most machines run Claude Code only.
	if !d.opt.DisableIngest {
		p := d.opt.OpenCodeDB
		if p == "" {
			p = opencode.DBPath()
		}
		if p == "off" {
			p = ""
		}
		if p != "" {
			ocdb, err := opencode.Open(p)
			if err != nil {
				// Read-only import of another program's database is a
				// convenience, never a reason to fail startup.
				d.log.Warn("opencode found but not readable", "component", "opencode", "path", p, "err", err)
			} else {
				// Announce only after a read succeeds. Opening a file that is
				// not a database succeeds — SQLite is lazy — so logging on open
				// promised a user with a corrupt or foreign file that their
				// sessions were being read while nothing was.
				if _, err := opencode.Sessions(ctx, ocdb); err != nil {
					d.log.Warn("opencode database found but not readable; skipping",
						"component", "opencode", "path", p, "err", err)
					_ = ocdb.Close()
				} else {
					d.ocIn = opencode.NewIngester(ocdb, d.rec, d.log, 5*time.Second)
					go func() {
						defer ocdb.Close()
						if err := d.ocIn.Run(ctx); err != nil {
							d.log.Error("opencode ingest stopped", "component", "opencode", "err", err)
						}
					}()
					d.log.Info("opencode sessions are being read", "component", "opencode", "db", p)

					// The poller is the floor; the stream removes the latency
					// on top of it. `opencode serve` runs while a TUI is open
					// and is gone otherwise, so failing to connect is the
					// normal case rather than an error — the streamer retries
					// with backoff and the poller covers the gap either way.
					st := opencode.NewStreamer(d.opt.OpenCodeURL, d.log)
					go st.Run(ctx, func(sessionID string) {
						d.ocIn.Touch(ctx, sessionID)
					})
				}
			}
		}
	}

	// Idle sweeper (also runs once at start so backfilled history settles immediately).
	_ = d.rec.MarkIdle(ctx, d.opt.IdleAfter, d.opt.EndAfter)
	// One release check at startup when the user enabled it — so the badge is
	// right on the first page load rather than a day later. Detached and
	// best-effort: a network failure must never delay or break startup.
	checks := d.config().UpdateChecks
	if checks {
		go func() {
			cctx, ccancel := context.WithTimeout(ctx, 10*time.Second)
			defer ccancel()
			if err := d.upd.Check(cctx, false); err != nil {
				d.log.Debug("release check failed", "component", "update", "err", err)
			}
		}()
	}
	go d.sweep(ctx)
	go d.backfillToolLinks(ctx)
	if d.config().RetentionDays > 0 {
		go d.pruneLoop(ctx)
	}

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	d.log.Info("caprock daemon listening", "component", "daemon", "url", d.url, "data_dir", d.opt.DataDir, "version", d.opt.Version)
	// enableHive logs which hive is in force (whether it came from --hive or from
	// the dashboard), so a detached daemon has a record of what it orchestrates.
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

func (d *Daemon) repoCwd() string {
	if d.opt.RepoCwd != "" {
		return d.opt.RepoCwd
	}
	wd, _ := os.Getwd()
	return wd
}

// hiveState returns the board and orchestrator under the lock that guards them.
// Both are nil until the task runner is enabled, and both are written from the
// request goroutine that enables it — so every read outside enableHive goes
// through here rather than touching the fields.
func (d *Daemon) hiveState() (*board.Board, *orchestrator.Orchestrator) {
	d.hiveMu.RLock()
	defer d.hiveMu.RUnlock()
	return d.board, d.orch
}

// enableHive builds the board and the orchestrator over a hive directory and
// installs them on the daemon. It is called once at startup when `--hive` was
// given, and again from POST /v1/hive when the user turns the task runner on
// from the dashboard — nothing here needs the process to restart: the store,
// bus, session manager and logger it wires together are all already running,
// and the API resolves the board per request through boardAdapter.
//
// Turning it on twice is refused rather than silently rebuilt: a second board
// over a different directory would leave the first one's router running against
// task files nobody is looking at.
func (d *Daemon) enableHive(ctx context.Context, hiveDir, repoCwd string) error {
	if hiveDir == "" {
		return errors.New("hive directory is required")
	}
	abs, err := filepath.Abs(hiveDir)
	if err != nil {
		return fmt.Errorf("resolve hive directory: %w", err)
	}
	hiveDir = abs
	if repoCwd != "" {
		if abs, err := filepath.Abs(repoCwd); err == nil {
			repoCwd = abs
		}
	}
	d.hiveMu.Lock()
	if d.board != nil {
		cur := d.opt.HiveDir
		d.hiveMu.Unlock()
		return fmt.Errorf("the task runner is already on (hive: %s)", cur)
	}
	d.hiveMu.Unlock()

	h, err := hive.Open(hiveDir)
	if err != nil {
		return fmt.Errorf("open hive: %w", err)
	}
	// A fresh hive was three empty directories. Seeding it with a README and
	// one example task makes the directory explain itself; it is a no-op on
	// a hive that already has one, so it never touches a user's work.
	if err := h.Seed(); err != nil {
		d.log.Warn("seed hive", "component", "board", "err", err)
	}
	b := board.New(h, d.store, d.bus, d.log)
	if err := b.Rescan(ctx); err != nil {
		d.log.Warn("hive rescan", "component", "board", "err", err)
	}
	b.RepoCwd = repoCwd
	d.hiveMu.Lock()
	d.opt.HiveDir, d.opt.RepoCwd = hiveDir, repoCwd
	d.hiveMu.Unlock()
	o := orchestrator.New(h, d.store, d.mgr, d.repoCwd(), d.log)
	// The router/kick goroutines must run under the daemon-lifetime context,
	// not the per-request context that started them (which is cancelled the
	// moment the handler returns).
	o.BaseCtx = d.baseCtx
	// Wire the router's verification step to the board without an import cycle:
	// the daemon owns both, so a closure over board.VerifyTask is the seam.
	o.Verify = func(ctx context.Context, taskID string) error {
		_, err := b.VerifyTask(ctx, taskID)
		return err
	}
	o.OverBudget = b.OverBudget
	// The router must be able to actually stop a session it spawned: parking
	// an over-budget task in a file does not halt the process that is
	// spending. Only sessions Caprock owns are reachable here (rule 7) —
	// agents.Manager refuses anything else.
	mgr := d.mgr
	o.Signal = func(sessionID, action string) error {
		return mgr.Signal(sessionID, ptyman.Signal(action))
	}

	d.hiveMu.Lock()
	d.board, d.orch = b, o
	d.hiveMu.Unlock()
	d.log.Info("task runner enabled", "component", "board", "hive", hiveDir, "repo", d.repoCwd())
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
				d.mu.Unlock()
				d.log.Warn("loop detected", "component", "loop", "session_id", a.SessionID, "tool", a.Tool, "count", a.Count, "sample", a.Sample)
				d.bus.Publish(bus.Frame{Type: bus.FrameAlert, Data: a})
				d.maybeAutoPause(a.SessionID)
			}
		}
	}
}

// stopDecision answers a worker's Stop hook: it resolves the payload's session
// to its hive agent and current task, then asks the board whether to force the
// worker to continue (non-empty inbox) or let it stop. Returns the decision JSON
// (nil ⇒ allow stop). This is the composed Decide closure, made a method so the
// resolve → StopDecision chain is testable end to end.
func (d *Daemon) stopDecision(ctx context.Context, p hookd.Payload) []byte {
	b, orch := d.hiveState()
	if b == nil {
		return nil
	}
	agentID := p.AgentID
	if agentID == "" && orch != nil {
		agentID = orch.AgentIDForSession(p.SessionID)
	}
	// The task id arms the per-(session,task) forced-continue guard (N=10, then
	// escalate). Without it the guard is inert.
	taskID := ""
	if orch != nil {
		taskID = orch.TaskForAgent(agentID)
	}
	return b.StopDecision(ctx, p.SessionID, agentID, taskID)
}

// maybeAutoPause pauses a looping session only when auto-pause is enabled AND
// the session is one Caprock spawned — we never signal a process we did not start
// (.ai/05-orchestration.md). Returns whether it paused (for tests).
func (d *Daemon) maybeAutoPause(sessionID string) bool {
	d.mu.Lock()
	autoPause := d.config().AutoPause
	d.mu.Unlock()
	if !autoPause {
		return false
	}
	if _, owned := d.mgr.Get(sessionID); !owned {
		return false
	}
	if err := d.mgr.Signal(sessionID, ptyman.SignalPause); err != nil {
		return false
	}
	d.log.Warn("auto-paused looping owned session", "component", "loop", "session_id", sessionID)
	d.bus.Publish(bus.Frame{Type: bus.FrameAlert, Data: map[string]any{"kind": "auto_paused", "session_id": sessionID}})
	return true
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

func (d *Daemon) pruneLoop(ctx context.Context) {
	prune := func() {
		// The goroutine is gated on RetentionDays > 0 at startup, but this closure
		// re-reads the config live. If retention ever reached 0 at runtime,
		// AddDate(0,0,0) is *now* and PruneEventsBefore would delete the entire
		// event history. No runtime writer exists today, so this is unreachable —
		// and it stays one refactor away from catastrophic without this line.
		days := d.config().RetentionDays
		if days <= 0 {
			return
		}
		before := d.rec.Now().AddDate(0, 0, -days).UnixMilli()
		var n int64
		if err := d.store.WithTx(ctx, func(q store.Querier) error {
			var e error
			n, e = store.PruneEventsBefore(ctx, q, before)
			return e
		}); err != nil {
			d.log.Warn("event prune", "component", "daemon", "err", err)
			return
		}
		if n > 0 {
			d.log.Info("pruned old events", "component", "daemon", "removed", n, "retention_days", days)
		}
	}
	prune() // once at start
	t := time.NewTicker(6 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			prune()
		}
	}
}

// toolLinkBatch is how many unlinked rows one backfill pass claims.
//
// The cost of a batch is dominated by the transcripts it opens, not by the row
// count: each pass re-walks the project tree for the sessions it touches, so
// SMALLER batches are slower overall, not faster. Measured on the owner's
// database (53967 unlinked rows, 1560 transcripts, 1 GB, 2026-08-23): 2000 →
// 48s, 10000 → 30s. The batch is therefore sized to amortise the walk, and it
// is bounded only so a kill costs one batch of work rather than the whole scan.
const toolLinkBatch = 10000

// backfillToolLinks recovers the historical tool→turn linkage in the
// background, after the daemon is already serving.
//
// WHY IT IS NOT PART OF STARTUP. It was, while it only looked at tool calls
// that named a file — a few hundred rows and about 3 seconds on the owner's
// database. Widening it to pathless calls (OQ-10) turned that into 53967 rows
// across a 1 GB transcript tree, measured at 34 seconds end to end. Thirty-four
// seconds before the port opens reads as a hang on the first `caprock up` after
// an upgrade, and the thing it is repairing is a historical report, not
// anything the daemon needs in order to serve. So it runs detached: the
// dashboard is up immediately, the breakdown fills in behind it, and a machine
// that is killed halfway resumes instead of starting over.
//
// The cursor is committed after every batch, so the worst case a kill can cost
// is one batch of work — never the whole scan, and never a wrong link, because
// a tool_use id resolves to exactly one message id (see BackfillToolMessageIDs).
func (d *Daemon) backfillToolLinks(ctx context.Context) {
	cur, _ := d.store.GetMeta(ctx, store.MetaToolLinkCursor)
	if cur == store.ToolLinkDone {
		return
	}
	after, _ := strconv.ParseInt(cur, 10, 64)
	var total int
	start := time.Now()
	for {
		if ctx.Err() != nil {
			return
		}
		n, last, err := ingest.BackfillToolMessageIDs(ctx, d.store.DB(), d.log, after, toolLinkBatch)
		if err != nil {
			// Degraded, not fatal: the affected rows report as unattributed and
			// the breakdown says so. The cursor is left where it was so the
			// next start retries this batch.
			d.log.Warn("could not link historical tool calls to their turns; some spend reports as unattributed",
				"component", "ingest", "err", err)
			return
		}
		total += n
		if last <= after {
			// No row past the cursor: the backfill is complete. Recorded as a
			// sentinel so later starts skip the scan entirely.
			_ = d.store.SetMeta(ctx, store.MetaToolLinkCursor, store.ToolLinkDone)
			if total > 0 {
				d.log.Info("linked historical tool calls to their turns",
					"component", "ingest", "events", total, "took", time.Since(start).Round(time.Millisecond))
			}
			return
		}
		after = last
		if err := d.store.SetMeta(ctx, store.MetaToolLinkCursor, strconv.FormatInt(after, 10)); err != nil {
			d.log.Warn("could not record tool-link backfill progress", "component", "ingest", "err", err)
			return
		}
	}
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
	Version string `json:"version"`
	// Platform is GOOS/GOARCH — the first thing a bug report needs and the
	// last thing anyone remembers to include.
	Platform  string        `json:"platform"`
	PID       int           `json:"pid"`
	StartedAt int64         `json:"started_at"`
	UptimeS   int64         `json:"uptime_s"`
	URL       string        `json:"url"`
	DataDir   string        `json:"data_dir"`
	Pricing   PricingStatus `json:"pricing"`
	Ingest    *ingest.Stats `json:"ingest,omitempty"`
	// IngestError is the terminal error that stopped transcript ingest, when
	// one happened (a read-only ~/.claude, a vanished transcript root). Empty
	// while ingest is running. Without it the daemon looked healthy while
	// capturing nothing, and the dashboard told the user to start `claude` and
	// wait for sessions that could never arrive.
	IngestError     string        `json:"ingest_error,omitempty"`
	Hooks           *hooks.Status `json:"hooks,omitempty"`
	UIBuilt         bool          `json:"ui_built"`
	ClaudeAvailable bool          `json:"claude_available"`
	// OpenCode reports what the second agent's reader is doing, or is absent
	// when OpenCode is not installed. Without it there was no way to tell
	// whether a machine that runs OpenCode was having those sessions read:
	// the dashboard shows them mixed in with Claude Code's, so their absence
	// looks the same as having none.
	OpenCode      *opencode.Stats `json:"opencode,omitempty"`
	OwnedActive   int             `json:"owned_active"`
	Orchestration bool            `json:"orchestration"`
	// Hive is the orchestration directory in force, and Repo the checkout its
	// workers operate on. Both empty when orchestration is off. Without them
	// there was no way — CLI, API or log — to ask which hive a running daemon
	// had been started with.
	Hive string `json:"hive,omitempty"`
	Repo string `json:"repo,omitempty"`
	// SuggestedHive and SuggestedRepo are what POST /v1/hive would use if it were
	// called with no body — the defaults the dashboard shows for confirmation
	// before turning the runner on. Present only while orchestration is off.
	SuggestedHive string `json:"suggested_hive,omitempty"`
	SuggestedRepo string `json:"suggested_repo,omitempty"`
	LoopK         int    `json:"loop_k"`
	LoopTMin      int    `json:"loop_t_minutes"`
	ActiveLoops   int    `json:"active_loops"`
	Events        int64  `json:"events"`
	RetentionDays int    `json:"retention_days"`
	// Desktop is the Claude desktop app's own plan usage, when it has any on
	// this machine. Omitted entirely otherwise — most people do not use it.
	Desktop *desktop.Reading `json:"desktop,omitempty"`
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
	b, _ := d.hiveState()
	st := Status{
		Version: d.opt.Version, Platform: runtime.GOOS + "/" + runtime.GOARCH, PID: os.Getpid(), StartedAt: d.start.UnixMilli(), UptimeS: int64(time.Since(d.start).Seconds()),
		URL: d.url, DataDir: d.opt.DataDir, UIBuilt: api.UIBuilt(),
		Pricing: PricingStatus{Version: d.table.Version, Source: d.table.Source, FetchedAt: d.table.FetchedAt, UserOverride: d.table.UserOverride, Models: len(d.table.Models)},
		LoopK:   d.det.K, LoopTMin: int(d.det.Window / time.Minute),
		OpenCode:        d.openCodeStats(),
		ClaudeAvailable: d.mgr.ClaudeAvailable(), OwnedActive: len(d.mgr.List()),
		Orchestration: b != nil,
	}
	if b != nil {
		d.hiveMu.RLock()
		st.Hive = d.opt.HiveDir
		d.hiveMu.RUnlock()
		st.Repo = d.repoCwd()
	} else {
		// With the runner off, the dashboard has to propose a hive and name the
		// repo it would work on before asking anyone to confirm. Both were only
		// knowable from the command line, so the screen could offer a command to
		// copy and nothing else. These are suggestions, not state: nothing is
		// created until POST /v1/hive.
		st.SuggestedHive, st.SuggestedRepo = suggestedHive(), d.repoCwd()
	}
	if d.tail != nil {
		s := d.tail.Stats()
		st.Ingest = &s
	}
	if err := d.ingestError(); err != nil {
		st.IngestError = err.Error()
	}
	// Read on request from a file the machine already has: no storage, no
	// polling, and absence is a normal answer rather than an error.
	if r, err := desktop.Latest(); err == nil {
		st.Desktop = &r
	}
	if p, err := hooks.DefaultSettingsPath(); err == nil {
		if hs, err := hooks.Inspect(p, config.ShimPath(d.opt.DataDir)); err == nil {
			st.Hooks = &hs
		}
	}
	d.mu.Lock()
	st.ActiveLoops = len(d.alerts)
	d.mu.Unlock()
	st.RetentionDays = d.config().RetentionDays
	if n, err := store.CountEvents(context.Background(), d.store.DB()); err == nil {
		st.Events = n
	}
	return st
}

// agentAdapter bridges *agents.Manager to api.AgentController.
// config returns a copy of the live configuration under the mutex that guards
// it. The settings endpoint mutates opt.Config at runtime, and opt.Config is a
// struct value — so an unguarded read races the four field writes in Set, and
// PlanLabel being a string makes a torn read a crash risk rather than merely
// a stale number.
func (d *Daemon) config() config.Config {
	d.cfgMu.RLock()
	defer d.cfgMu.RUnlock()
	return d.opt.Config
}

// settingsAdapter persists the user-stated settings to the config file, so a
// value survives a restart. The daemon keeps an in-memory copy because the API
// reads it on every summary render.
type settingsAdapter struct{ d *Daemon }

func (a *settingsAdapter) Get() api.Settings {
	a.d.cfgMu.RLock()
	defer a.d.cfgMu.RUnlock()
	c := a.d.opt.Config
	return api.Settings{
		UpdateChecks:    c.UpdateChecks,
		PlanKind:        c.PlanKind,
		PlanLabel:       c.PlanLabel,
		PlanUSDPerMonth: c.PlanUSDPerMonth,
		LicenseKey:      c.LicenseKey,
	}
}

func (a *settingsAdapter) Set(in api.Settings) error {
	a.d.cfgMu.Lock()
	justEnabled := in.UpdateChecks && !a.d.opt.Config.UpdateChecks
	a.d.opt.Config.UpdateChecks = in.UpdateChecks
	a.d.opt.Config.PlanKind = in.PlanKind
	a.d.opt.Config.PlanLabel = in.PlanLabel
	a.d.opt.Config.PlanUSDPerMonth = in.PlanUSDPerMonth
	// Trimmed on the way in: a key pasted with a stray newline is the most
	// likely way the one interaction that turns a payment into a working
	// feature goes wrong, and storing it dirty makes every later read wrong.
	a.d.opt.Config.LicenseKey = strings.TrimSpace(in.LicenseKey)
	cfg := a.d.opt.Config
	a.d.cfgMu.Unlock()
	// Turning checks on should show an answer immediately rather than after
	// the next restart. Runs detached so the PUT stays fast, and under the
	// daemon's lifetime context so it is not cancelled with the request.
	if justEnabled {
		go func() {
			ctx, cancel := context.WithTimeout(context.WithoutCancel(a.d.baseCtx), 10*time.Second)
			defer cancel()
			_ = a.d.upd.Check(ctx, true)
		}()
	}
	return config.Save(a.d.opt.DataDir, cfg)
}

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

// boardAdapter bridges the board to api.TaskController. It holds the daemon
// rather than the board itself, because the task runner can be turned on after
// the API was built (POST /v1/hive) — a captured *board.Board would have been
// nil forever in that case, and the endpoints would keep answering 501 to a user
// who had just switched the feature on.
type boardAdapter struct{ d *Daemon }

// suggestedHive is the queue directory the dashboard offers when the runner is
// off: `~/caprock-tasks`, the same path the README and the CLI help use. It
// falls back to a relative name only if the home directory cannot be resolved.
func suggestedHive() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "caprock-tasks"
	}
	return filepath.Join(home, "caprock-tasks")
}

var errOrchDisabled = errors.New("the task runner is off — turn it on from the dashboard's Tasks screen, or start caprock with --hive")

// board resolves the live board, or reports that the runner is off.
func (a *boardAdapter) board() (*board.Board, *orchestrator.Orchestrator, error) {
	b, o := a.d.hiveState()
	if b == nil {
		return nil, nil, errOrchDisabled
	}
	return b, o, nil
}

// Enabled reports whether the task runner is on, so the API can answer 501 on
// the task endpoints without holding a nil controller.
func (a *boardAdapter) Enabled() bool {
	b, _ := a.d.hiveState()
	return b != nil
}

// Enable turns the task runner on over an existing daemon. It is the whole
// reason the board is resolved per call rather than captured.
func (a *boardAdapter) Enable(ctx context.Context, hiveDir, repoCwd string) (any, error) {
	if hiveDir == "" {
		hiveDir = suggestedHive()
	}
	if repoCwd == "" {
		repoCwd = a.d.repoCwd()
	}
	if err := a.d.enableHive(ctx, hiveDir, repoCwd); err != nil {
		return nil, err
	}
	a.d.hiveMu.RLock()
	defer a.d.hiveMu.RUnlock()
	return map[string]string{"hive": a.d.opt.HiveDir, "repo": a.d.opt.RepoCwd}, nil
}

func (a *boardAdapter) List(ctx context.Context) (any, error) {
	b, _, err := a.board()
	if err != nil {
		return nil, err
	}
	return b.List(ctx)
}

func (a *boardAdapter) Create(ctx context.Context, req any) (any, error) {
	b, _, err := a.board()
	if err != nil {
		return nil, err
	}
	return b.Create(ctx, req)
}

// Get returns the board's task detail plus *where the work is*. The board knows
// the task; only this layer knows the repo, the worker's branch and worktree,
// and the sessions that spent money on it — and without those the card was a
// title, an id and a dollar figure, with the diff sitting behind an endpoint
// nothing linked to. Everything added here is derived, never stored: the branch
// and worktree are the same strings `agents.createWorktree` builds.
func (a *boardAdapter) Get(ctx context.Context, id string) (any, error) {
	bd, _, err := a.board()
	if err != nil {
		return nil, err
	}
	out, err := bd.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	m, ok := out.(map[string]any)
	if !ok {
		return out, nil
	}
	work := map[string]any{}
	// The mirror row drops done_criteria, so the card could never show what
	// "done" is going to mean for this task. Read it back off the hive file.
	if t, err := bd.Hive.GetTask(id); err == nil {
		m["done_criteria"] = t.DoneCriteria
	}
	if row, ok := m["task"].(store.TaskRow); ok && row.Assignee != "" {
		// One worktree per agent: `git worktree add -B caprock/<worker>
		// <repo>/.caprock-worktrees/<worker>` (internal/agents/worktree.go).
		work["branch"] = "caprock/" + row.Assignee
		work["worktree"] = board.WorktreePath(bd.RepoCwd, row.Assignee)
	}
	if bd.RepoCwd != "" {
		work["repo"] = bd.RepoCwd
	}
	if sess, err := store.TaskSessions(ctx, bd.Store.DB(), id); err == nil && len(sess) > 0 {
		work["sessions"] = sess
	}
	if vs, err := store.Verifications(ctx, bd.Store.DB(), id); err == nil && len(vs) > 0 {
		work["verifications"] = vs
	}
	if len(work) > 0 {
		m["work"] = work
	}
	return m, nil
}

func (a *boardAdapter) Approve(ctx context.Context, id string, ok bool) error {
	b, _, err := a.board()
	if err != nil {
		return err
	}
	return b.Approve(ctx, id, ok)
}

func (a *boardAdapter) Approvals(ctx context.Context) (any, error) {
	b, _, err := a.board()
	if err != nil {
		return nil, err
	}
	return b.Approvals(ctx)
}

func (a *boardAdapter) Verify(ctx context.Context, id string) (any, error) {
	b, _, err := a.board()
	if err != nil {
		return nil, err
	}
	return b.VerifyTask(ctx, id)
}

func (a *boardAdapter) StartOrchestrator(ctx context.Context) (any, error) {
	_, orch, err := a.board()
	if err != nil {
		return nil, err
	}
	if orch == nil {
		return nil, errOrchDisabled
	}
	sid, err := orch.Start(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]string{"session_id": sid}, nil
}

// StopOrchestrator is the emergency stop: kill the orchestrator and every worker
// it spawned, and latch the router so it does not respawn them next tick.
func (a *boardAdapter) StopOrchestrator(_ context.Context) (any, error) {
	_, orch, err := a.board()
	if err != nil {
		return nil, err
	}
	if orch == nil {
		return nil, errOrchDisabled
	}
	return map[string]int{"stopped": orch.StopAll()}, nil
}

// openCodeStats reports the OpenCode reader, or nil when it is not running.
func (d *Daemon) openCodeStats() *opencode.Stats {
	if d.ocIn == nil {
		return nil
	}
	st := d.ocIn.Stats()
	return &st
}
