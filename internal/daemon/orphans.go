package daemon

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/procstat"
	"github.com/dspv/caprock/internal/ptyhost"
	"github.com/dspv/caprock/internal/store"
)

// The orphan scan: processes on this machine that look abandoned — another
// Caprock's daemon or terminal holder, a `claude` whose session ended or
// whose parent is gone, an MCP server whose Claude Code exited — listed in
// the footprint with why each is there, and stopped only when the user says
// so, one listed process at a time (ADR-059). Reading the process table
// signals nothing; the stop is the one place Caprock signals a process it
// may not have started, and it is never automatic. Contract in
// 03-contracts.md § Footprint.

// Orphan kinds, in the order the list shows them.
const (
	OrphanDaemon = "caprock_daemon" // another `caprock up --foreground`
	OrphanHolder = "caprock_holder" // a terminal holder no Caprock will reattach to
	// OrphanOldHolder is a holder this Caprock still lists, running from
	// another install's executable: a session that outlived a move between
	// installs (Homebrew to the app). Something runs in it; never ticked.
	OrphanOldHolder    = "caprock_old_holder"
	OrphanCaprockOther = "caprock_other" // any other caprock command whose parent is gone
	OrphanClaude       = "claude"        // a claude whose session ended or whose parent is gone
	OrphanCodex        = "codex"         // a codex CLI whose session ended or whose parent is gone
	OrphanMCP          = "mcp_server"    // an MCP server whose parent is gone
	OrphanClaudeChild  = "claude_child"  // started from a Claude Code session, parent gone
)

var orphanKindOrder = map[string]int{
	OrphanDaemon: 0, OrphanHolder: 1, OrphanOldHolder: 2, OrphanCaprockOther: 3, OrphanClaude: 4, OrphanCodex: 5, OrphanMCP: 6, OrphanClaudeChild: 7,
}

// orphanStopGrace is how long a stop waits, after its one signal, for the
// process to go before it reports it still running (ADR-059, amended
// 2026-10-18: SIGKILL only on a second click).
const orphanStopGrace = 5 * time.Second

// orphanListTTL is how old a scan the open doctor may be answered with: it
// asks every 10 s, and a scan reads every process's argv once. Check now,
// `caprock doctor` and every stop take one at once.
const orphanListTTL = 30 * time.Second

// cmdMax is how many characters of a command line an orphan carries.
const cmdMax = 160

// OrphanReport is the footprint's `orphans`.
type OrphanReport struct {
	// Scanned is true when List was taken for this answer. Otherwise the
	// counts are the last scan's (the 10-minute sweep, or the doctor's last
	// look) and List is empty.
	Scanned bool `json:"scanned"`
	// At is when the counted scan ran, unix ms.
	At     int64          `json:"at"`
	Count  int            `json:"count"`
	ByKind map[string]int `json:"by_kind"`
	// MemBytes is the memory of every listed process together: the strip's
	// "orphans 3 · 410 MB".
	MemBytes uint64   `json:"mem_bytes"`
	List     []Orphan `json:"list"`
	// Note says what this scan could not look at.
	Note string `json:"note,omitempty"`
}

// Orphan is one process that looks abandoned. PID and StartedAt together
// name it: a stop names both, and a pid whose start has changed is another
// process and is not signalled.
type Orphan struct {
	PID       int32  `json:"pid"`
	StartedAt int64  `json:"started_at"`
	Kind      string `json:"kind"`
	// Label is the program and, for Caprock, its subcommand: "caprock
	// pty-host", "claude", "node server-github".
	Label string `json:"label"`
	// Cmd is the command line, cut to cmdMax characters, the program by its
	// base name and the value of anything that names a token, key, secret or
	// password hidden (cmdLine). Empty when argv cannot be read.
	Cmd string `json:"cmd,omitempty"`
	Exe string `json:"exe,omitempty"`
	// DataDir is the Caprock data directory a daemon or holder belongs to,
	// when it can be told; DataDirGone is set when it no longer exists.
	DataDir     string `json:"data_dir,omitempty"`
	DataDirGone bool   `json:"data_dir_gone,omitempty"`
	// CPUPct is absent until there are two samples of it.
	CPUPct   *float64 `json:"cpu_pct,omitempty"`
	MemBytes uint64   `json:"mem_bytes"`
	// Why is the reason it is listed, in a sentence.
	Why string `json:"why"`
	// Auto is set on a holder the daemon stops on its own (the sweep).
	Auto bool `json:"auto,omitempty"`
}

// OrphanTarget names one listed process to stop: its pid and the start
// time the list gave.
type OrphanTarget = api.OrphanTarget

// OrphanStopResult is POST /v1/footprint/orphans/stop.
type OrphanStopResult struct {
	Stopped []Orphan `json:"stopped"`
	// Running got its signal and was still there when the grace ran out.
	// Nothing more was sent: a SIGKILL is the user's second click (force).
	Running []Orphan      `json:"running"`
	Failed  []ReapFailure `json:"failed"`
}

// orphanInput is everything the classifier reads besides the meter's
// per-process caches (argv, environment, executable, terminal).
type orphanInput struct {
	tab  *procstat.Table
	scan caprockScan
	// holders is ptyhost.Classify of scan.hosts, in the same order.
	holders []ptyhost.Verdict
	// skip is this daemon, the doctor and the daemon that answers it.
	skip map[int32]bool
	// live is every process of a live session's tree.
	live map[int32]bool
	// ended is, by pid, the latest ended session that ran in it.
	ended map[int32]store.EndedPID
	now   time.Time
	// exists reports whether a directory (or a file) is still there.
	exists func(string) bool
	// installDirs is where the answering daemon's own executables live
	// (installDirs()); a holder it lists that runs from elsewhere is an old
	// install's. Empty when there is no daemon to compare with: then no
	// holder is judged by its executable.
	installDirs []string
}

// mcpWord finds MCP in a command line: "mcp-server-fetch", "server-mcp",
// "fastmcp", "@modelcontextprotocol/…", not "compcpu".
var mcpWord = regexp.MustCompile(`(^|[^a-z0-9])mcp|mcp([^a-z0-9]|$)|modelcontextprotocol`)

// reaped reports whether p's parent is gone: it was handed to launchd or
// init (pid 1), to a Linux subreaper (`systemd --user`), or — on Windows,
// which does not reparent — its parent pid is not running or now names a
// younger process.
func reaped(tab *procstat.Table, p procstat.Proc) bool {
	if p.PPID <= 1 {
		return true
	}
	par, ok := tab.Procs[p.PPID]
	if !ok {
		return true
	}
	if par.StartMs > 0 && p.StartMs > 0 && par.StartMs > p.StartMs {
		return true
	}
	switch strings.ToLower(par.Name) {
	case "systemd", "init", "launchd":
		return true
	}
	return false
}

// inAppBundle is a macOS app or one of its helpers: launchd's children by
// design (the Claude desktop app is "Claude"), never an orphan. A bundle
// inside a framework is not an app: Homebrew's and python.org's Python run
// every script as .../Python.framework/.../Python.app/Contents/MacOS/Python.
func inAppBundle(exe string) bool {
	e := filepath.ToSlash(exe)
	i := strings.Index(e, ".app/Contents/")
	return i >= 0 && !strings.Contains(e[:i], ".framework/")
}

// caprockCLI is whether exe is the caprock binary itself, not another
// program whose name starts with caprock.
func caprockCLI(exe string) bool {
	b := strings.TrimSuffix(strings.ToLower(filepath.Base(filepath.ToSlash(exe))), ".exe")
	return b == "caprock"
}

// claudeLike is whether a process is Claude Code: named claude (the native
// binary sets it; argv[0] says so when the file is named by its version), or
// node or bun running the npm package.
func claudeLike(name string, argv []string) bool {
	if n := strings.TrimSuffix(strings.ToLower(name), ".exe"); n == "claude" {
		return true
	}
	if len(argv) == 0 {
		return false
	}
	if b := strings.TrimSuffix(strings.ToLower(filepath.Base(filepath.ToSlash(argv[0]))), ".exe"); b == "claude" {
		return true
	}
	if procstat.IsInterpreter(argv[0]) || procstat.IsInterpreter(name) {
		for _, a := range argv[1:] {
			if strings.Contains(filepath.ToSlash(a), "@anthropic-ai/claude-code") {
				return true
			}
		}
	}
	return false
}

// codexLike is whether a process is the Codex CLI: named codex, argv[0]
// says so, or node or bun running the npm package. Its services are not:
// `codex app-server` (the Codex desktop app's managed daemon, launchd's
// child by design) and anything under its packages' app-server directory.
func codexLike(name string, argv []string, exe string) bool {
	if strings.Contains(filepath.ToSlash(exe), "/app-server-daemon/") {
		return false
	}
	is := strings.TrimSuffix(strings.ToLower(name), ".exe") == "codex"
	if len(argv) > 0 {
		if b := strings.TrimSuffix(strings.ToLower(filepath.Base(filepath.ToSlash(argv[0]))), ".exe"); b == "codex" {
			is = true
		}
		if !is && (procstat.IsInterpreter(argv[0]) || procstat.IsInterpreter(name)) {
			for _, a := range argv[1:] {
				if strings.Contains(filepath.ToSlash(a), "@openai/codex") {
					is = true
					break
				}
			}
		}
	}
	if !is {
		return false
	}
	for _, a := range argv[1:] {
		if a == "app-server" {
			return false
		}
	}
	return true
}

// agentCandidates is every process the classifier might call claude or
// codex, so the caller knows which pids to ask the store about: one of this
// user's, with no terminal and not in an app bundle.
func (m *resourceMeter) agentCandidates(ctx context.Context, tab *procstat.Table, skip map[int32]bool) []int32 {
	var out []int32
	for pid, p := range tab.Procs {
		if pid <= 1 || skip[pid] || !sameUser(p) || !maybeAgent(p.Name) {
			continue
		}
		k := pidKey{pid, p.StartMs}
		if m.ttyOf(k, p) {
			continue
		}
		argv, exe := m.argvOf(ctx, k), m.exeOf(ctx, k)
		if !claudeLike(p.Name, argv) && !codexLike(p.Name, argv, exe) || inAppBundle(exe) {
			continue
		}
		out = append(out, pid)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// maybeAgent is the cheap test before argv is read: names Claude Code and
// the Codex CLI run under.
func maybeAgent(name string) bool {
	n := strings.TrimSuffix(strings.ToLower(name), ".exe")
	if n == "claude" || n == "codex" || n == "node" || n == "bun" {
		return true
	}
	// The native binary's file is named by its version: "2.1.296".
	return n != "" && strings.Trim(n, "0123456789.") == "" && strings.Contains(n, ".")
}

// orphans classifies the table. Conservative on purpose: anything with a
// controlling terminal, in a live session's tree, of another user, younger
// than ptyhost.OrphanAge or inside an app bundle is never listed.
func (m *resourceMeter) orphans(ctx context.Context, in orphanInput) []Orphan {
	var out []Orphan
	listed := map[int32]bool{}
	add := func(o Orphan) {
		if listed[o.PID] {
			return
		}
		listed[o.PID] = true
		out = append(out, o)
	}
	old := func(start int64) bool {
		return start == 0 || in.now.Sub(time.UnixMilli(start)) >= ptyhost.OrphanAge
	}
	gone := func(dir string) bool { return dir != "" && in.exists != nil && !in.exists(dir) }

	// Caprock's own: other daemons, holders nobody will reattach to, and any
	// other caprock command left behind.
	for _, p := range in.scan.daemons {
		if in.skip[p.PID] {
			continue
		}
		pr := in.tab.Procs[p.PID]
		dir := p.DataDir
		if dir == "" {
			dir = defaultDataDirFor(m.envOf(ctx, pidKey{p.PID, pr.StartMs}))
		}
		o := Orphan{PID: p.PID, StartedAt: pr.StartMs, Kind: OrphanDaemon, Label: "caprock up", Exe: p.Exe, DataDir: dir, DataDirGone: gone(dir)}
		switch {
		case dir == "":
			o.Why = "Another Caprock daemon; its data directory cannot be told."
		case o.DataDirGone:
			o.Why = "Another Caprock daemon, whose data directory is gone: nothing can use it."
		default:
			o.Why = "Another Caprock daemon, for another data directory."
		}
		add(o)
	}
	for i, h := range in.scan.hosts {
		v := in.holders[i]
		if in.skip[h.PID] {
			continue
		}
		if !v.Orphan() {
			if o, ok := oldInstallHolder(in, h, v, old); ok {
				add(o)
			}
			continue
		}
		o := Orphan{PID: h.PID, StartedAt: h.StartMs, Kind: OrphanHolder, Label: "caprock pty-host", Exe: in.scan.hostExe[h.PID], Auto: v.Reap}
		if reg := ptyhost.RegistryOf(h.Env); reg != "" {
			o.DataDir = filepath.Dir(reg)
			o.DataDirGone = v.Abandoned
		}
		switch v.State {
		case "dead":
			o.Why = "A terminal holder whose program has exited: nothing runs in it. The daemon stops it on its own."
		case "unreachable-idle":
			o.Why = "A terminal holder no Caprock can reattach to, holding an idle shell. The daemon stops it on its own."
		default:
			child := v.Child
			if child == "" {
				child = "a program"
			}
			o.Why = fmt.Sprintf("A terminal holder no Caprock can reattach to; %s still runs in it, so it is never stopped on its own. Stopping it closes its terminal.", child)
		}
		if v.Abandoned {
			o.Why += " Its data directory is gone."
		}
		add(o)
	}
	for _, c := range in.scan.other {
		p, ok := in.tab.Procs[c.pid]
		if !ok || in.skip[c.pid] || in.live[c.pid] || !old(c.start) || !reaped(in.tab, p) || m.ttyOf(pidKey{c.pid, p.StartMs}, p) {
			continue
		}
		// A Caprock app of its own (Caprock Mail is caprock-mail) is
		// launchd's child by design, like any app: only the CLI itself, even
		// the one inside Caprock.app, can be left behind.
		if inAppBundle(c.exe) && !caprockCLI(c.exe) {
			continue
		}
		label := "caprock"
		if c.sub != "" && !strings.HasPrefix(c.sub, "-") {
			label += " " + c.sub
		}
		add(Orphan{PID: c.pid, StartedAt: c.start, Kind: OrphanCaprockOther, Label: label, Exe: c.exe,
			Why: "A Caprock command whose parent has exited, with no terminal."})
	}

	// Everything else: claude, MCP servers, what Claude Code started.
	for pid, p := range in.tab.Procs {
		if pid <= 1 || listed[pid] || in.skip[pid] || in.live[pid] || !sameUser(p) || !old(p.StartMs) {
			continue
		}
		low := strings.ToLower(p.Name)
		if strings.HasPrefix(low, "caprock") {
			continue // the caprock branch above judged it
		}
		k := pidKey{pid, p.StartMs}
		isParentGone := reaped(in.tab, p)
		e, hasEnded := in.ended[pid]
		// The process must have existed when that session started: a pid
		// reused since belongs to someone else.
		hasEnded = hasEnded && e.StartedAt > 0 && p.StartMs > 0 && p.StartMs <= e.StartedAt+60_000
		mcpName := strings.Contains(low, "mcp")
		candidate := maybeAgent(p.Name) || mcpName || procstat.IsInterpreter(p.Name) || low == "npm"
		if !candidate || (!isParentGone && !hasEnded) {
			continue
		}
		if m.ttyOf(k, p) {
			continue
		}
		argv := m.argvOf(ctx, k)
		exe := m.exeOf(ctx, k)
		if inAppBundle(exe) {
			continue
		}
		o := Orphan{PID: pid, StartedAt: p.StartMs, Exe: exe}
		switch {
		case claudeLike(p.Name, argv):
			o.Kind, o.Label, o.Why = OrphanClaude, "claude", agentWhy("claude", hasEnded, in.now, e)
		case codexLike(p.Name, argv, exe):
			o.Kind, o.Label, o.Why = OrphanCodex, "codex", agentWhy("codex", hasEnded, in.now, e)
		case !isParentGone:
			continue // only claude is judged by its session
		case mcpName || mcpWord.MatchString(strings.ToLower(strings.Join(argv, " "))):
			o.Kind, o.Label = OrphanMCP, procstat.Label(p.Name, argv)
			o.Why = "An MCP server whose parent has exited (usually the claude that started it), with no terminal."
		case hasEnv(m.envOf(ctx, k), "CLAUDECODE"):
			o.Kind, o.Label = OrphanClaudeChild, procstat.Label(p.Name, argv)
			o.Why = "Started from a Claude Code session (CLAUDECODE is in its environment); its parent has exited and it has no terminal. It may be a server left running on purpose."
		default:
			continue
		}
		add(o)
	}
	for i := range out {
		if p, ok := in.tab.Procs[out[i].PID]; ok {
			out[i].Cmd = cmdLine(m.argvOf(ctx, pidKey{p.PID, p.StartMs}))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if a, b := orphanKindOrder[out[i].Kind], orphanKindOrder[out[j].Kind]; a != b {
			return a < b
		}
		return out[i].PID < out[j].PID
	})
	return out
}

func agentWhy(name string, ended bool, now time.Time, e store.EndedPID) string {
	if ended {
		return fmt.Sprintf("A %s whose session ended (last heard from %s ago), still running with no terminal.", name, ago(now, e.LastEventAt))
	}
	return fmt.Sprintf("A %s whose parent has exited, with no terminal and no live session in Caprock.", name)
}

// oldInstallHolder lists a holder this Caprock still lists (a session it
// can attach to) when it runs from another install's executable: a
// Homebrew `caprock pty-host` left from before the move to the app, still
// holding a session days later. Something runs in it, so it is said, never
// stopped on its own and never ticked.
func oldInstallHolder(in orphanInput, h ptyhost.HostProc, v ptyhost.Verdict, old func(int64) bool) (Orphan, bool) {
	exe := in.scan.hostExe[h.PID]
	if v.State != "registered" || exe == "" || len(in.installDirs) == 0 || inInstall(exe, in.installDirs) || !old(h.StartMs) {
		return Orphan{}, false
	}
	child, live := v.Child, false
	if child == "" {
		child = "a program"
	}
	for _, c := range h.Children {
		live = live || in.live[c.PID]
	}
	o := Orphan{PID: h.PID, StartedAt: h.StartMs, Kind: OrphanOldHolder, Label: "caprock pty-host", Exe: exe}
	if reg := ptyhost.RegistryOf(h.Env); reg != "" {
		o.DataDir = filepath.Dir(reg)
	}
	o.Why = fmt.Sprintf("A terminal holder from another Caprock install (%s), started %s ago", exe, Age(in.now.Sub(time.UnixMilli(h.StartMs))))
	if in.exists != nil && !in.exists(exe) {
		o.Why += "; that program file is gone"
	}
	o.Why += fmt.Sprintf(". This Caprock still lists it and %s runs in it", child)
	if live {
		o.Why += " as a live session"
	}
	o.Why += ", so it is never stopped on its own. Stopping it ends that session."
	return o, true
}

// inInstall is whether an executable lives in one of an install's
// directories.
func inInstall(exe string, dirs []string) bool {
	for _, d := range dirs {
		if sameDir(filepath.Dir(exe), d) {
			return true
		}
	}
	return false
}

// secretArg finds an argument or flag that names a credential.
var secretArg = regexp.MustCompile(`(?i)(token|secret|passw|api[-_]?key|apikey|auth|credential|bearer|cookie|private[-_]?key)`)

// urlUserinfo is the user:password@ part of a URL.
var urlUserinfo = regexp.MustCompile(`(://)[^/@\s:]+:[^/@\s]+@`)

// cmdLine is a command line for a person: the program by its base name, an
// argument with a space quoted, the value of any flag or KEY=VALUE that
// names a token, key, secret or password replaced by [hidden], a URL's
// password removed, and the whole cut to cmdMax characters.
func cmdLine(argv []string) string {
	if len(argv) == 0 {
		return ""
	}
	parts := make([]string, 0, len(argv))
	hideNext := false
	for i, a := range argv {
		a = strings.Join(strings.Fields(a), " ") // newlines and tabs in a prompt
		switch {
		case i == 0:
			// Either separator: a Windows argv[0] read on any OS.
			a = a[strings.LastIndexAny(a, `/\`)+1:]
		case hideNext:
			a, hideNext = "[hidden]", false
		default:
			if k, _, ok := strings.Cut(a, "="); ok && secretArg.MatchString(k) {
				a = k + "=[hidden]"
			} else if strings.HasPrefix(a, "-") && secretArg.MatchString(a) {
				hideNext = true
			}
		}
		a = urlUserinfo.ReplaceAllString(a, "${1}[hidden]@")
		if strings.Contains(a, " ") || a == "" {
			a = `"` + a + `"`
		}
		parts = append(parts, a)
	}
	s := strings.Join(parts, " ")
	if r := []rune(s); len(r) > cmdMax {
		s = string(r[:cmdMax-1]) + "…"
	}
	return s
}

func hasEnv(env []string, key string) bool {
	for _, kv := range env {
		k, v, ok := strings.Cut(kv, "=")
		if ok && v != "" && v != "0" && strings.EqualFold(k, key) {
			return true
		}
	}
	return false
}

// defaultDataDirFor is the data directory a Caprock with this environment
// and no CAPROCK_DATA_DIR uses (config.DataDir: os.UserConfigDir/caprock);
// "" when the environment does not say.
func defaultDataDirFor(env []string) string {
	get := func(key string) string {
		for _, kv := range env {
			if k, v, ok := strings.Cut(kv, "="); ok && strings.EqualFold(k, key) {
				return v
			}
		}
		return ""
	}
	switch runtime.GOOS {
	case "windows":
		if a := get("APPDATA"); a != "" {
			return filepath.Join(a, "caprock")
		}
	case "darwin", "ios":
		if h := get("HOME"); h != "" {
			return filepath.Join(h, "Library", "Application Support", "caprock")
		}
	default:
		if x := get("XDG_CONFIG_HOME"); x != "" && filepath.IsAbs(x) {
			return filepath.Join(x, "caprock")
		}
		if h := get("HOME"); h != "" {
			return filepath.Join(h, ".config", "caprock")
		}
	}
	return ""
}

func ago(now time.Time, ms int64) string {
	if ms <= 0 {
		return "a while"
	}
	return Age(now.Sub(time.UnixMilli(ms)))
}

// Age is a duration for a person: 40s, 12m, 3h, 7d (days from 48 hours).
func Age(d time.Duration) string {
	switch {
	case d >= 48*time.Hour:
		return fmt.Sprintf("%dd", int(d/(24*time.Hour)))
	case d >= time.Hour:
		return fmt.Sprintf("%dh", int(d/time.Hour))
	case d >= time.Minute:
		return fmt.Sprintf("%dm", int(d/time.Minute))
	}
	return fmt.Sprintf("%ds", int(d/time.Second))
}

func (m *resourceMeter) ttyOf(k pidKey, p procstat.Proc) bool {
	t, ok := m.tty[k]
	if !ok {
		t = procstat.HasTTY(p)
		m.tty[k] = t
	}
	return t
}

// liveTrees is every process of every live session's tree.
func liveTrees(tab *procstat.Table, sessions map[string]int32) map[int32]bool {
	out := map[int32]bool{}
	for _, pid := range sessions {
		for _, p := range tab.Tree(pid) {
			out[p] = true
		}
	}
	return out
}

func dirExists(dir string) bool {
	_, err := os.Stat(dir)
	return err == nil || !errors.Is(err, os.ErrNotExist)
}

// newOrphanReport counts a list.
func newOrphanReport(list []Orphan, at time.Time) OrphanReport {
	r := OrphanReport{Scanned: true, At: at.UnixMilli(), Count: len(list), ByKind: map[string]int{}, List: list}
	if r.List == nil {
		r.List = []Orphan{}
	}
	for _, o := range list {
		r.ByKind[o.Kind]++
		r.MemBytes += o.MemBytes
	}
	return r
}

// orphanScanNote is what a scan cannot see on this OS.
func orphanScanNote() string {
	if runtime.GOOS == "windows" {
		return "Windows has no terminals to check and does not reparent: a process counts as parentless when its parent pid is not running or names a younger process."
	}
	return ""
}

// scanOrphans takes the orphan list now and keeps its counts for the
// footprint's later answers.
func (d *Daemon) scanOrphans(ctx context.Context) OrphanReport {
	d.res.mu.Lock()
	defer d.res.mu.Unlock()
	now := time.Now()
	tab, err := procstat.Read(ctx)
	if err != nil {
		r := newOrphanReport(nil, now)
		r.Note = err.Error()
		return r
	}
	self := int32(os.Getpid())
	skip := map[int32]bool{self: true}
	scan := d.res.scanCaprock(ctx, tab, self)
	exe, _ := os.Executable()
	in := orphanInput{
		tab: tab, scan: scan, skip: skip, now: now, exists: dirExists,
		holders:     ptyhost.Classify(scan.hosts, ptyhost.Dir(d.opt.DataDir), now),
		live:        liveTrees(tab, d.sessionPIDs(ctx)),
		installDirs: installDirs(exe, d.opt.HolderExe, d.opt.DataDir),
	}
	note := orphanScanNote()
	if cands := d.res.agentCandidates(ctx, tab, skip); len(cands) > 0 && d.store != nil {
		pids := make([]int, len(cands))
		for i, p := range cands {
			pids[i] = int(p)
		}
		ended, err := store.EndedByPID(ctx, d.store.DB(), pids)
		if err != nil {
			note = strings.TrimSpace(note + " Sessions could not be read: " + err.Error())
		}
		in.ended = make(map[int32]store.EndedPID, len(ended))
		for pid, e := range ended {
			in.ended[int32(pid)] = e
		}
	}
	list := d.res.orphans(ctx, in)
	d.res.measureOrphans(tab, list)
	r := newOrphanReport(list, now)
	r.Note = note
	d.res.orphLast = r
	return r
}

// measureOrphans fills each orphan's memory and CPU from the orphan
// sampler, which is the resource meter's sampler's twin: one sampler
// forgets every process it was not asked about, so sharing one would reset
// the session figures' CPU rate each time the doctor looked.
func (m *resourceMeter) measureOrphans(tab *procstat.Table, list []Orphan) {
	pids := make([]int32, len(list))
	for i, o := range list {
		pids[i] = o.PID
	}
	use := m.orphSampler.Sample(tab, pids)
	for i := range list {
		u := use[list[i].PID]
		list[i].MemBytes = u.MemBytes
		if u.Warm {
			c := u.CPUPct
			list[i].CPUPct = &c
		}
	}
}

// orphanList is the list for the open doctor: the last scan when it is
// younger than orphanListTTL, a new one otherwise or when fresh (Check
// now).
func (d *Daemon) orphanList(ctx context.Context, fresh bool) OrphanReport {
	d.res.mu.Lock()
	last := d.res.orphLast
	d.res.mu.Unlock()
	if !fresh && last.Scanned && last.At > 0 && time.Since(time.UnixMilli(last.At)) < orphanListTTL {
		return last
	}
	return d.scanOrphans(ctx)
}

// orphanCounts is the last scan's counts without its list, for a footprint
// that did not ask for the list. The first one after start scans.
func (d *Daemon) orphanCounts(ctx context.Context) OrphanReport {
	d.res.mu.Lock()
	last := d.res.orphLast
	d.res.mu.Unlock()
	if last.At == 0 {
		last = d.scanOrphans(ctx)
	}
	last.Scanned = false
	last.List = []Orphan{}
	return last
}

// OfflineOrphans is the orphan list `caprock doctor` takes itself when no
// daemon answers (or the one that answers predates the scan). Without the
// daemon's store there are no sessions to check: a claude is judged by its
// parent alone. running is the daemon that answers for dataDir but predates
// the scan, 0 when none answers; it and the doctor itself are never listed.
func OfflineOrphans(ctx context.Context, dataDir string, running int32) OrphanReport {
	m := newResourceMeter()
	now := time.Now()
	tab, err := procstat.Read(ctx)
	if err != nil {
		r := newOrphanReport(nil, now)
		r.Note = err.Error()
		return r
	}
	self := int32(os.Getpid())
	sk := map[int32]bool{self: true}
	if running > 0 {
		sk[running] = true
	}
	scan := m.scanCaprock(ctx, tab, self)
	// An old install's holder is judged against the daemon that answers;
	// with none, there is no install to compare with.
	var dirs []string
	if running > 0 {
		if e := procstat.Exe(ctx, running); e != "" {
			dirs = installDirs(e, "", dataDir)
		}
	}
	list := m.orphans(ctx, orphanInput{
		tab: tab, scan: scan, skip: sk, now: now, exists: dirExists,
		holders:     ptyhost.Classify(scan.hosts, ptyhost.Dir(dataDir), now),
		live:        map[int32]bool{},
		installDirs: dirs,
	})
	m.measureOrphans(tab, list)
	r := newOrphanReport(list, now)
	why := "No daemon answered"
	if running > 0 {
		why = "The daemon that answered predates the orphan scan"
	}
	r.Note = strings.TrimSpace(orphanScanNote() + " " + why + ", so sessions were not checked: a claude is listed only when its parent is gone.")
	return r
}

// --- stopping ----------------------------------------------------------------

// signaller is what a stop sends. Tests replace it; nothing in a test
// signals a process it did not start.
type signaller interface {
	terminate(pid int32) error
	kill(pid int32) error
	// startOf is the pid's start time, false when no such process runs.
	startOf(ctx context.Context, pid int32) (int64, bool)
}

type osSignaller struct{}

func (osSignaller) terminate(pid int32) error { return terminate(int(pid)) }
func (osSignaller) kill(pid int32) error      { return kill(int(pid)) }
func (osSignaller) startOf(ctx context.Context, pid int32) (int64, bool) {
	if exited(pid) {
		return 0, false
	}
	return procstat.StartMs(ctx, pid)
}

// stopProc sends one process one signal — SIGTERM, or SIGKILL when force
// (the user's second click on a process that outlived SIGTERM); Windows has
// only TerminateProcess — and waits up to grace for it to go. It reports
// running when the process is still there then; nothing more is sent. The
// pid's start time is checked before the signal and while waiting: a pid
// that names another process now is never signalled. Only this pid is
// signalled — never its children.
func stopProc(ctx context.Context, s signaller, pid int32, start int64, grace time.Duration, force bool) (running bool, err error) {
	same := func() bool {
		st, ok := s.startOf(ctx, pid)
		return ok && st == start
	}
	if pid <= 1 || start == 0 || !same() {
		return false, errChanged
	}
	send := s.terminate
	if force {
		send = s.kill
	}
	if err := send(pid); err != nil {
		if !same() {
			return false, nil // it ended on its own meanwhile
		}
		return false, err
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		if !same() {
			return false, nil
		}
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return same(), nil
}

// errNotListed is a target the fresh scan does not list.
var errNotListed = errors.New("not on the doctor's list now: it exited, stopped looking abandoned, or its pid names another process")

// stopListed stops each target that list holds with the same start time,
// all at once, and refuses the rest. list must be a scan taken for this
// stop, not one the caller kept. force sends SIGKILL instead of SIGTERM.
func stopListed(ctx context.Context, s signaller, list []Orphan, targets []OrphanTarget, grace time.Duration, force bool) OrphanStopResult {
	res := OrphanStopResult{Stopped: []Orphan{}, Running: []Orphan{}, Failed: []ReapFailure{}}
	byPID := map[int32]Orphan{}
	for _, o := range list {
		byPID[o.PID] = o
	}
	var (
		mu sync.Mutex
		wg sync.WaitGroup
	)
	seen := map[int32]bool{}
	for _, t := range targets {
		if seen[t.PID] {
			continue
		}
		seen[t.PID] = true
		o, ok := byPID[t.PID]
		if !ok || o.StartedAt != t.StartedAt || t.StartedAt == 0 {
			// Under mu: the stops started for earlier targets are already
			// appending their own results. Unlocked, the two appends raced,
			// and one result vanished from the reply (seen on Windows CI,
			// 2026-10-14: a process that was never stopped was not reported
			// as failed either).
			mu.Lock()
			res.Failed = append(res.Failed, ReapFailure{PID: t.PID, Error: errNotListed.Error()})
			mu.Unlock()
			continue
		}
		wg.Add(1)
		go func(o Orphan) {
			defer wg.Done()
			running, err := stopProc(ctx, s, o.PID, o.StartedAt, grace, force)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err != nil:
				res.Failed = append(res.Failed, ReapFailure{PID: o.PID, Error: err.Error()})
			case running:
				res.Running = append(res.Running, o)
			default:
				res.Stopped = append(res.Stopped, o)
			}
		}(o)
	}
	wg.Wait()
	byPIDOrder := func(xs []Orphan) {
		sort.Slice(xs, func(i, j int) bool { return xs[i].PID < xs[j].PID })
	}
	byPIDOrder(res.Stopped)
	byPIDOrder(res.Running)
	sort.Slice(res.Failed, func(i, j int) bool { return res.Failed[i].PID < res.Failed[j].PID })
	return res
}

// stopOrphans is POST /v1/footprint/orphans/stop: the user's click on Stop,
// Clean up or — for one still running after SIGTERM — Force stop. It scans
// again and stops only what that scan lists with the start time the click
// named (ADR-059).
func (d *Daemon) stopOrphans(ctx context.Context, targets []OrphanTarget, force bool) OrphanStopResult {
	list := d.scanOrphans(ctx).List
	res := stopListed(ctx, d.signals(), list, targets, orphanStopGrace, force)
	sig := map[bool]string{false: "SIGTERM", true: "SIGKILL"}[force]
	for _, o := range res.Stopped {
		d.log.Info("stopped a process the user picked from the doctor's orphan list", "component", "resources", "pid", o.PID, "kind", o.Kind, "label", o.Label, "signal", sig)
	}
	for _, o := range res.Running {
		d.log.Info("a process the user picked from the doctor's orphan list outlived its signal", "component", "resources", "pid", o.PID, "kind", o.Kind, "label", o.Label, "signal", sig)
	}
	if len(res.Stopped) > 0 {
		d.scanOrphans(ctx) // the counts the strip shows
	}
	return res
}

func (d *Daemon) signals() signaller {
	if d.sig != nil {
		return d.sig
	}
	return osSignaller{}
}

// StopOrphansOffline is `caprock doctor --stop` with no daemon to ask: the
// same rule, against the doctor's own scan.
func StopOrphansOffline(ctx context.Context, dataDir string, targets []OrphanTarget, running int32, force bool) OrphanStopResult {
	list := OfflineOrphans(ctx, dataDir, running).List
	return stopListed(ctx, osSignaller{}, list, targets, orphanStopGrace, force)
}
