// Package agents spawns and controls Claude Code sessions Caprock owns: a real
// `claude` process in a PTY, its output buffered for the terminal view and its
// exit recorded. Externally started sessions are never touched here — we only
// spawn, type into, pause and kill processes we started (.ai/05-orchestration.md).
package agents

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/ptyhost"
	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/subs"
	"github.com/dspv/caprock/internal/termbuf"
	"github.com/dspv/caprock/internal/userenv"
)

// SpawnRequest describes a session to launch.
type SpawnRequest struct {
	Cwd      string `json:"cwd"`
	Chat     bool   `json:"chat,omitempty"`     // a quick chat: Caprock picks the directory, no repository needed
	Create   bool   `json:"create,omitempty"`   // make Cwd if it does not exist (one level, under an existing parent)
	Worktree string `json:"worktree,omitempty"` // git worktree name to create under the repo
	// WorktreeBase is the branch a new worktree starts from (HEAD when empty);
	// WorktreePull fetches it from its remote first.
	WorktreeBase string `json:"worktree_base,omitempty"`
	WorktreePull bool   `json:"worktree_pull,omitempty"`
	// WorktreePR starts the new worktree from a GitHub pull request's head
	// instead: refs/pull/<n>/head, fetched from the repository's remote with
	// the user's own git credentials (prStartPoint). Needs Worktree; not with
	// WorktreeBase.
	WorktreePR     int    `json:"worktree_pr,omitempty"`
	Model          string `json:"model,omitempty"`           // --model
	PermissionMode string `json:"permission_mode,omitempty"` // --permission-mode
	Command        string `json:"command,omitempty"`         // default "claude"
	// Agent picks which coding agent to launch: "claude" (default), "codex",
	// "opencode" or "gemini". They take different flags, so the argv is built
	// per agent (argv.go) rather than pretending one shape fits all four.
	Agent string `json:"agent,omitempty"`
	// Resume continues an existing conversation instead of starting a new one.
	//
	// This is how a session that lives in somebody's terminal can be picked up
	// inside Caprock. It cannot type into a process it did not start — two
	// writers on one PTY interleave characters and ruin both — so it starts a
	// second process on the same conversation, which is what `--resume` is for.
	// The history is on disk, so nothing is lost and nothing is fought over.
	Resume string `json:"resume,omitempty"`
	// Fork branches the resumed conversation into a new session id rather than
	// reusing the original.
	//
	// Set when the session being picked up is still running somewhere: two live
	// processes claiming one id would write the same transcript and each end up
	// with half the other's turns. A fork keeps the history and leaves the
	// original alone. Claude Code refuses --session-id alongside --resume
	// unless --fork-session is present, which is the same distinction from the
	// other side.
	Fork bool `json:"fork,omitempty"`
	// NativeResume is the agent's own id for the session being resumed, when
	// it differs from Caprock's (a Codex or OpenCode session Caprock started;
	// sessions.native_id). Filled by the daemon from the store, never by the
	// browser.
	NativeResume string `json:"-"`
	// Prompt is the first message, sent as the session starts. A relay's
	// brief: built by Caprock, read and edited by the user, and sent only when
	// they click Start. Ignored on a resume.
	Prompt string `json:"prompt,omitempty"`
	// RelayFrom is the session whose work this new one carries on
	// (sessions.relay_from). The daemon records it; the agent never sees it.
	RelayFrom string `json:"relay_from,omitempty"`
	// GeminiKey is the key the daemon holds, passed into the child's
	// environment. Never accepted from the browser — the API fills it in from
	// settings, so a page cannot hand a spawned process someone else's
	// credential.
	GeminiKey string `json:"-"`
	// Subscription is the sign-in to run on (ADR-048): a subscription id from
	// Settings → Subscriptions, or "" (or "default") for the user's normal
	// one. Claude Code and Codex only. Recorded on the session.
	Subscription string `json:"subscription,omitempty"`
	// ConfigDir is that subscription's configuration directory, set by the
	// daemon from its own settings — never from the request, so a page cannot
	// point a session at a directory of its choosing. It becomes
	// CLAUDE_CONFIG_DIR or CODEX_HOME in the child's environment.
	ConfigDir string `json:"-"`
	// DeepSeekKey is the user's DeepSeek key, for a Claude Code session on
	// DeepSeek (Subscription subs.DeepSeekID). Like GeminiKey it is never
	// accepted from the browser: the daemon fills it in from its settings.
	DeepSeekKey string `json:"-"`
	// SubagentModel is the model Claude Code's subagents run on:
	// "haiku", "sonnet" or "opus" (SubagentModels), or "" to follow the
	// session. It becomes CLAUDE_CODE_SUBAGENT_MODEL in the child's
	// environment; nothing else from the request reaches it.
	SubagentModel string `json:"subagent_model,omitempty"`
	// EndWhenDone asks the daemon to end the session, the way End does,
	// once its turn finishes with nothing waiting on anyone: a scripted
	// one-job start that would otherwise sit idle at its prompt for good
	// (daemon/enddone.go). Claude Code and Codex only, with a prompt.
	EndWhenDone bool `json:"end_when_done,omitempty"`
	// Automation says a scheduled job started this session, not a person:
	// Second Brain never reads it and hands it nothing (store.
	// MarkBrainAutomation, written in the spawn's transaction). Nothing else
	// in Caprock changes for it.
	Automation bool     `json:"automation,omitempty"`
	Args       []string `json:"args,omitempty"` // extra args
	Cols       int      `json:"cols,omitempty"`
	Rows       int      `json:"rows,omitempty"`
}

// Agent is a live owned session.
type Agent struct {
	SessionID string
	Cwd       string
	Worktree  string
	Command   string
	StartedAt time.Time
	// Kind is which coding agent this is ("claude", "codex", …).
	Kind string
	// Port is the loopback port an OpenCode TUI's own server listens on, so
	// the daemon can learn the session id it creates; 0 for other agents and
	// for a resumed OpenCode session, whose id is already known.
	Port int
	// current is the session a /clear started in this process, nil before
	// one has (Current, follow.go).
	current atomic.Pointer[string]
	// NativeID is the agent's own id for a new session Caprock named at the
	// start — an OpenCode 2 session (`--session <id>` creates it) — for the
	// daemon to link at once; "" otherwise.
	NativeID string
	// EndWhenDone: the spawn asked for the session to be ended once its
	// turn finishes (SpawnRequest.EndWhenDone). Kept in the pty-host's
	// metadata, so a restarted daemon still knows.
	EndWhenDone bool

	sess ptyman.Session
	ring *ring
	// outAt is when the session last wrote output, unix ns; 0 before it has.
	outAt  atomic.Int64
	inputs *termbuf.Inputs // sequenced input, when the session cannot keep it itself
	log    *slog.Logger
	mu     sync.Mutex
	subs   map[chan []byte]struct{}
	done   chan struct{}
	exit   int
	exited bool
	onExit func(sessionID string, code int)

	// ioAt is when the session last wrote output or was typed into, unix
	// ns; 0 before either. Unlike outAt it never counts the screen a
	// pty-host replays to a daemon that reattaches (quietUntil): that is
	// the past drawn again, and counting it would make every restart look
	// like activity to the idle end (daemon/endidle.go).
	ioAt atomic.Int64
	// quietUntil is, for a reattached session, the unix ns until which
	// output is the holder's replay, not new activity; 0 otherwise.
	quietUntil int64

	// cols and rows are the terminal's size as last set, read when a
	// permission answer reads the screen.
	sizeMu     sync.Mutex
	cols, rows int

	// fg is a shell's foreground program, as last read (shell.go).
	fg fgCache

	// setupDone is closed when a fresh worktree's setup, run in this
	// terminal before the agent, is over (worktreesetup.go); nil when the
	// session had none.
	setupDone chan struct{}

	// typedAny is set by the first input typed into the session: an exit
	// after it is somebody closing it, not a program that never started
	// (EarlyExit).
	typedAny atomic.Bool
	// stopped is set when Caprock was asked to end it (End, a stop signal,
	// a restart): an exit then is not one the program chose.
	stopped atomic.Bool
	// pumped is closed when its output has been read to the end, so the
	// screen it left is complete when its exit is recorded.
	pumped chan struct{}
	// retry is the request that started it, for Try again (ExitReport);
	// nil for a session reattached from an earlier daemon.
	retry *SpawnRequest
	// argv0 and argv are what was run, for the log line of an early exit.
	argv0 string
	argv  []string
}

// Manager owns the set of running agents.
type Manager struct {
	pty     ptyman.Manager
	hosts   *ptyhost.Manager // set by UseHosts; nil runs sessions in-process
	store   *store.Store
	log     *slog.Logger
	dataDir string
	claude  string // resolved claude binary (or "claude")
	// vers overrides an agent's version, by agent name; tests set it.
	// ocVersions caches what `opencode --version` answered (opencode.go).
	vers       map[string]string
	ocVersions versions
	// binVersions caches `--version` of a binary an early exit ran, for its
	// log line (exitreport.go).
	binVersions versions
	// bins overrides where an agent's binary is, by agent name; tests set it.
	// Everything else is resolved at the moment it is needed (findBinary),
	// because a CLI installed while the daemon runs should be offered without
	// a restart.
	bins map[string]string
	// shellCmd overrides the login shell a shell tab runs; tests set it.
	shellCmd func() (string, []string)
	mu       sync.Mutex
	agents   map[string]*Agent
	// exits is how recently ended sessions ended, newest exitReportsKept,
	// oldest first in exitOrder (exitreport.go).
	exits     map[string]ExitReport
	exitOrder []string
	// follows files a session a /clear started under the id of the terminal
	// it runs in (follow.go): new id → spawn id.
	follows  map[string]string
	OnExit   func(sessionID string, code int)
	OnOutput func(sessionID string) // called (throttled by caller) when new bytes arrive
	// OnPermission is told when an owned session starts or stops waiting on a
	// permission prompt (p is nil when it stops), or the one it shows
	// changes. See permission.go.
	OnPermission func(sessionID string, p *Permission)
	// ProjectSetup returns the setup command set for the project a directory
	// is in (projects' defaults.setup_command), or "". It runs in a fresh
	// worktree's terminal before the agent starts (ADR-050). Nil means none.
	ProjectSetup func(dir string) string
	// SetupExe is the Caprock binary whose `worktree-setup` runs that
	// command and then becomes the agent. Empty skips the command.
	SetupExe string
	// ProjectPrompt returns the instructions the user set for the project a
	// directory is in (projects' defaults.system_prompt), or "". A Claude Code
	// session started there gets them through --append-system-prompt, a Codex
	// one as developer_instructions. Set by the daemon; nil means none.
	ProjectPrompt func(dir string) string
	// ProjectRepos returns the other member repositories of the multi-repo
	// project a directory is in (projects' OtherRepos, ADR-055): a Claude
	// Code or Codex session started there gets each as --add-dir, a Gemini
	// one as --include-directories. Nil means none.
	ProjectRepos func(dir string) []string
	permMu       sync.Mutex
	// perms is each session's prompts still outstanding, oldest first. Which
	// one its screen shows is not known when there are several (ADR-035,
	// amended 2026-10-09).
	perms map[string][]*Permission
	// calls is each session's newest PreToolUse calls, so a PermissionRequest
	// — which carries no tool_use_id — is tied to the call it asks about.
	calls map[string][]preCall
	// persistMu serialises writing perms to the store, and persisting tracks
	// the writes in flight (see persistPermission).
	persistMu  sync.Mutex
	persisting sync.WaitGroup
	// BypassConsent reports whether Claude Code's one-time bypass warning
	// has been accepted in the settings a session started with configDir
	// ("" for the user's own) reads. A Claude Code session is started with
	// --allow-dangerously-skip-permissions only when it has, so Shift+Tab can
	// reach bypass without that start opening on the warning (ADR-054). Nil
	// means never.
	BypassConsent func(configDir string) bool
	// modeMu guards modes and restarting (modeswitch.go).
	modeMu sync.Mutex
	// modes is each owned session's permission mode as last seen: from its
	// own hooks, or read off its screen after a switch.
	modes map[string]seenMode
	// restarting marks a session being stopped to be resumed in another
	// mode, so its terminals are told to reconnect rather than that it ended.
	restarting map[string]bool
	// nudgeMu guards nudges (nudge.go).
	nudgeMu sync.Mutex
	// nudges is each owned session's newest input that its status reads
	// before the session writes an event for it.
	nudges map[string]narrate.Nudge
	// OnNudge is told when one is noted, with the session's agent kind, so
	// every screen asks for the session's status again at once. It must
	// not block: a keystroke calls it.
	OnNudge func(sessionID, kind string, n narrate.Nudge)
	// NewSessionID generates a session id; overridable in tests.
	NewSessionID func() string
	// Now is the clock chat directory names are stamped from; overridable in
	// tests so a name can be asserted rather than merely observed to exist.
	Now func() time.Time
}

// now is Manager.Now, or the wall clock when a manager was built by hand.
func (m *Manager) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

// NewManager builds a manager. claudePath "" resolves "claude" on PATH.
func NewManager(st *store.Store, dataDir, claudePath string, log *slog.Logger) *Manager {
	if log == nil {
		log = slog.Default()
	}
	if claudePath == "" {
		claudePath = resolveClaude()
	}
	return &Manager{pty: ptyman.New(), store: st, log: log, dataDir: dataDir, claude: claudePath, agents: map[string]*Agent{}, NewSessionID: config.NewSessionID, Now: time.Now}
}

// binary is the executable to start for an agent: an absolute path when one
// was found, the bare name otherwise (the start then fails with the PTY's own
// "not found", which is what an unavailable agent should do).
func (m *Manager) binary(agent string) string {
	if agent == "" || agent == AgentClaude {
		return m.claude
	}
	if p, ok := m.bins[agent]; ok {
		return p
	}
	if p := findBinary(agent); p != "" {
		return p
	}
	return agent
}

// AgentAvailable reports whether an agent's binary can be launched, so the
// dialog offers only the agents this machine has: a choice that fails on
// click is worse than no choice.
func (m *Manager) AgentAvailable(agent string) bool {
	if agent == "" || agent == AgentClaude {
		return m.ClaudeAvailable()
	}
	if !IsSpawnable(agent) {
		return false
	}
	p := m.binary(agent)
	if !filepath.IsAbs(p) {
		return false
	}
	return isExecutable(p)
}

// geminiApprovalMode maps a Claude permission mode onto Gemini's --approval-mode,
// which covers the same ground with four values instead of six: default (ask),
// auto_edit (edits without asking), yolo (everything without asking), plan
// (read-only). Claude's manual and dontAsk have no counterpart that is not a
// guess about what the user meant, so they are left off and Gemini uses its own
// default — asking is the safe end of that axis.
func geminiApprovalMode(claudeMode string) string {
	switch claudeMode {
	case "acceptEdits":
		return "auto_edit"
	case "bypassPermissions", "auto":
		return "yolo"
	case "plan":
		return "plan"
	default:
		return ""
	}
}

// telemetryPath is where a Gemini session's telemetry is written, and where
// the ingester later reads it from. Empty when there is no data directory to
// put it in, which turns the feature off rather than failing the spawn — a
// session that runs unobserved is worse than one that does not run at all only
// if you forget to say so, and the session screen does say so.
func (m *Manager) telemetryPath(sessionID string) string {
	if m.dataDir == "" {
		return ""
	}
	dir := filepath.Join(m.dataDir, "gemini")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	return filepath.Join(dir, sessionID+".otel.log")
}

// GeminiAvailable reports whether the Gemini CLI can be launched.
func (m *Manager) GeminiAvailable() bool { return m.AgentAvailable(AgentGemini) }

// ClaudeAvailable reports whether the resolved claude binary can be launched.
func (m *Manager) ClaudeAvailable() bool {
	if filepath.IsAbs(m.claude) {
		fi, err := os.Stat(m.claude)
		return err == nil && !fi.IsDir()
	}
	_, err := exec.LookPath(m.claude)
	return err == nil
}

// ClaudeBinary is the claude executable the manager starts, "" when this
// machine has none. Second Brain's extraction calls the same one (ADR-063).
func (m *Manager) ClaudeBinary() string {
	if !m.ClaudeAvailable() {
		return ""
	}
	return m.claude
}

// resolveClaude finds the claude binary: PATH first, then the well-known install
// locations, because the daemon's PATH (especially when launched from a GUI or a
// service manager) often omits ~/.local/bin where the CLI installs itself.
func resolveClaude() string {
	if p, err := exec.LookPath("claude"); err == nil {
		return p
	}
	name := "claude"
	if runtime.GOOS == "windows" {
		name = "claude.exe"
	}
	home, _ := os.UserHomeDir()
	candidates := []string{
		filepath.Join(home, ".local", "bin", name),
		filepath.Join(home, ".claude", "local", name),
		filepath.Join(home, "bin", name),
		filepath.Join("/opt", "homebrew", "bin", name),
		filepath.Join("/usr", "local", "bin", name),
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c
		}
	}
	return "claude"
}

// ownDirs are Caprock's own directories a session is allowed to read without
// being asked, passed as --add-dir.
//
// Caprock writes files the user then refers to by path — a screenshot pasted
// into the terminal lands in PasteDir — and those paths are outside every
// working directory. A user with Claude Code's
// `permissions.blockReadsOutsideWorkingDirectories` on was therefore asked
// about Caprock's own files, in every permission mode: that setting is a
// separate guard and no permission mode, bypass included, lifts it.
// Naming the directories is the narrow fix — it allows the two places Caprock
// writes to and nothing else.
func (m *Manager) ownDirs() []string {
	if m.dataDir == "" {
		return nil
	}
	var dirs []string
	for _, d := range []string{config.PasteDir(m.dataDir), config.ChatsDir(m.dataDir)} {
		// Claude Code refuses to start on an --add-dir that does not exist,
		// and a fresh install has neither until the first paste or chat.
		if err := os.MkdirAll(d, 0o700); err != nil {
			m.log.Warn("cannot prepare a directory for --add-dir; reads there may be asked about",
				"component", "agents", "dir", d, "err", err)
			continue
		}
		dirs = append(dirs, d)
	}
	return dirs
}

// newChatDir makes a home for one quick chat.
//
// Vova uses Claude to ask things — look something up, talk a problem through —
// and the spawn dialog demanded an absolute path to a repository before it
// would start anything. For "just ask a question" that is a wall, so Caprock
// picks the directory itself.
//
// One directory PER CHAT, not one shared `chats/` folder: Claude Code keys a
// transcript by its working directory, so a shared folder would collapse every
// conversation the user ever had into a single project row worth thousands of
// dollars, with no way to tell one from another. Dated names sort themselves,
// and a chat's own directory is somewhere Claude can write scratch files
// without touching anyone's repository.
func (m *Manager) newChatDir() (string, error) {
	if m.dataDir == "" {
		return "", errors.New("no data directory, so a chat has nowhere to live")
	}
	base := config.ChatsDir(m.dataDir)
	if err := os.MkdirAll(base, 0o700); err != nil {
		return "", fmt.Errorf("create chats directory: %w", err)
	}
	// Second granularity plus a counter: two chats started inside the same
	// second would otherwise land in one directory and share a transcript.
	stamp := m.now().Format("2006-01-02-150405")
	for i := 0; ; i++ {
		name := stamp
		if i > 0 {
			name = fmt.Sprintf("%s-%d", stamp, i+1)
		}
		dir := filepath.Join(base, name)
		if err := os.Mkdir(dir, 0o700); err == nil {
			return dir, nil
		} else if !os.IsExist(err) {
			return "", fmt.Errorf("create chat directory: %w", err)
		}
		if i > 100 {
			return "", errors.New("could not find a free chat directory name")
		}
	}
}

// IsChatDir reports whether dir is one chat's own folder, directly inside the
// chats workspace: `<data_dir>/chats/<name>` (ADR-071). The workspace itself
// is not a chat.
func (m *Manager) IsChatDir(dir string) bool {
	return IsChatDirIn(m.dataDir, dir)
}

// IsChatDirIn is IsChatDir for a data directory the caller names.
func IsChatDirIn(dataDir, dir string) bool {
	if dataDir == "" || dir == "" {
		return false
	}
	dir = filepath.Clean(dir)
	name := filepath.Base(dir)
	return filepath.Dir(dir) == filepath.Clean(config.ChatsDir(dataDir)) && name != "." && !strings.HasPrefix(name, ".")
}

// makeProjectDir creates a directory for a new project, one level deep.
//
// This runs on a POST that already executes a command from its body, so it is
// deliberately the narrowest thing that satisfies the request: **one** level,
// under a parent that already exists. `MkdirAll` would happily materialise
// `/a/b/c/d` from a typo, and the v0.17.0 audit found six defects that all
// began with treating a path from a request as trustworthy.
//
// The parent must exist and be a directory, so this cannot walk anywhere the
// user has not already been. An existing target is not an error — the caller
// asked for a directory to exist and it does.
func makeProjectDir(dir string) error {
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("%q is not an absolute path", dir)
	}
	// Clean first: `/Users/me/dev/../../../etc/x` is absolute and still escapes
	// wherever the user thought they were.
	dir = filepath.Clean(dir)
	parent := filepath.Dir(dir)
	if parent == dir {
		return fmt.Errorf("refusing to create the filesystem root")
	}
	fi, err := os.Stat(parent)
	if err != nil || !fi.IsDir() {
		return fmt.Errorf("%q does not exist, so %q cannot be created in it", parent, filepath.Base(dir))
	}
	// Mkdir, never MkdirAll — the parent check above is the guard, and this
	// call is what keeps it a guard. MkdirAll here would create the chain the
	// check just refused, so the two have to stay in agreement.
	if err := os.Mkdir(dir, 0o755); err != nil && !os.IsExist(err) {
		return fmt.Errorf("could not create %q: %w", dir, err)
	}
	return nil
}

// Spawn launches a new session and registers it. The PTY session id is forced
// with `claude --session-id <uuid>` so hooks and transcript arrive under the id
// Caprock already knows.
func (m *Manager) Spawn(ctx context.Context, req SpawnRequest) (*Agent, error) {
	if req.Chat && req.Cwd == "" {
		dir, err := m.newChatDir()
		if err != nil {
			return nil, err
		}
		req.Cwd = dir
	}
	if req.Cwd == "" {
		return nil, errors.New("spawn without cwd")
	}
	if fi, err := os.Stat(req.Cwd); err != nil || !fi.IsDir() {
		if !req.Create {
			return nil, fmt.Errorf("cwd %q is not a directory", req.Cwd)
		}
		if err := makeProjectDir(req.Cwd); err != nil {
			return nil, err
		}
	}
	sessionID := m.NewSessionID()
	cwd := req.Cwd
	worktree := ""
	var setup worktreeSetup
	if req.WorktreePR != 0 && (req.Worktree == "" || req.WorktreeBase != "" || req.WorktreePR < 0) {
		return nil, errors.New("agents: worktree_pr needs a worktree name and a positive number, and no worktree_base")
	}
	if req.Worktree != "" {
		base, pull := req.WorktreeBase, req.WorktreePull
		if req.WorktreePR > 0 {
			ref, err := prStartPoint(ctx, req.Cwd, req.WorktreePR)
			if err != nil {
				return nil, err
			}
			base, pull = ref, false
			defer dropPRRef(ctx, req.Cwd, ref)
		}
		wt, err := makeWorktree(ctx, req.Cwd, req.Worktree, base, pull)
		if err != nil {
			return nil, err
		}
		cwd, worktree = wt.Dir, req.Worktree
		if wt.Fresh {
			setup = m.prepareWorktree(ctx, req.Cwd, wt)
		}
	}
	agent := req.Agent
	if agent == "" {
		agent = AgentClaude
	}
	command := req.Command
	var args, extraEnv []string
	port := 0
	nativeID, typed := "", ""
	if command != "" {
		// An explicit command is taken as given: the caller knows what it is
		// launching, and guessing flags for an unknown binary is worse than
		// launching it bare.
		args = append(args, req.Args...)
	} else {
		build, ok := builders[agent]
		if !ok {
			return nil, fmt.Errorf("caprock cannot start %q sessions", agent)
		}
		in := launchInput{
			SessionID: sessionID, Cwd: cwd, Model: req.Model, Mode: req.PermissionMode,
			Resume: req.Resume, NativeResume: req.NativeResume, Fork: req.Fork, Extra: req.Args,
			Prompt: req.Prompt, AddDirs: m.ownDirs(),
		}
		if agent == AgentClaude && m.BypassConsent != nil {
			in.AllowBypass = m.BypassConsent(req.ConfigDir)
		}
		if (agent == AgentClaude || agent == AgentCodex || agent == AgentGrok) && m.ProjectPrompt != nil {
			in.SystemPrompt = m.ProjectPrompt(cwd)
		}
		if m.ProjectRepos != nil {
			in.RepoDirs = m.ProjectRepos(cwd)
		}
		if in.Prompt != "" && isBatch(m.binary(agent)) {
			in.Prompt = flattenForBatch(in.Prompt)
		}
		// OpenCode 1 and 2 take different flags (opencode.go).
		if agent == AgentOpenCode {
			in.OpenCodeMajor = m.openCodeMajor()
			in.Now = m.now()
		}
		// A new OpenCode 1 session is named by OpenCode when the first
		// message is sent; its TUI's own server announces the id, on a port
		// chosen here so nothing else can be on it. OpenCode 2 is given the
		// id instead.
		if agent == AgentOpenCode && req.Resume == "" && in.OpenCodeMajor < 2 {
			p, err := freePort()
			if err != nil {
				m.log.Warn("no free port for opencode; its session will not be linked", "component", "agents", "err", err)
			} else {
				in.Port, port = p, p
			}
		}
		l, err := build(in)
		if err != nil {
			return nil, err
		}
		command, args, extraEnv, sessionID = m.binary(agent), l.args, l.env, l.sessionID
		nativeID, typed = l.nativeID, l.typed
	}

	// Pre-accept Claude Code's folder-trust dialog so the spawned session does
	// not block on it (best-effort; a failure here must not stop the spawn).
	// Only for Claude Code: the other agents are told on their command line,
	// and writing ~/.claude.json for a Codex session would claim a folder for
	// a program that never asked.
	sub := req.Subscription
	if sub == "default" {
		sub = ""
	}
	onDeepSeek := sub == subs.DeepSeekID
	switch {
	case onDeepSeek && (agent != AgentClaude || req.DeepSeekKey == ""):
		return nil, fmt.Errorf("DeepSeek runs Claude Code sessions on your DeepSeek key: set the key in Settings → Subscriptions")
	case !onDeepSeek && sub != "" && (req.ConfigDir == "" || (agent != AgentClaude && agent != AgentCodex)):
		return nil, fmt.Errorf("subscription %q cannot start a %s session", sub, agent)
	}
	if agent == AgentClaude {
		trust := trustFolder
		if req.ConfigDir != "" {
			// Claude Code reads trust from the .claude.json of the
			// configuration directory it runs with (ADR-048).
			trust = func(dir string) error { return trustFolderInProfile(req.ConfigDir, dir) }
		}
		if err := trust(cwd); err != nil {
			m.log.Warn("pre-trust folder", "component", "agents", "cwd", cwd, "err", err)
		}
	}

	env := childEnv(userenv.Environ(m.log))
	env = withEnv(env, extraEnv)
	env = withSubagentModel(env, agent, req.SubagentModel)
	if req.ConfigDir != "" {
		env = onSubscription(env, agent, req.ConfigDir)
	}
	// Claude Code on DeepSeek (provider.go): the model calls go to DeepSeek on
	// the user's key, which reaches this child's environment and nothing else.
	if onDeepSeek {
		env = withDeepSeek(env, req.DeepSeekKey)
	}
	// The Gemini CLI reads GEMINI_API_KEY from its environment, and the key the
	// user pasted into the dashboard lives in the daemon's config — so it has
	// to be handed over here or the child asks for a key it cannot see. Only
	// when the environment does not already carry one: a machine set up the old
	// way keeps what it had, and the child sees one value rather than two.
	if req.Agent == AgentGemini && req.GeminiKey != "" && os.Getenv("GEMINI_API_KEY") == "" {
		env = append(env, "GEMINI_API_KEY="+req.GeminiKey)
	}
	// Gemini has no hooks and no transcript, so without this Caprock starts a
	// session and then sees nothing it does — which is exactly what 0.44.x
	// shipped: a live session showing zero turns and zero cost. It does write
	// OpenTelemetry, and to a local file when told to, which makes that file
	// the counterpart of Claude Code's transcript.
	//
	// The file is per-session and lives beside the rest of Caprock's data. Not
	// in the user's project: a telemetry file appearing inside a repository is
	// a file somebody has to gitignore, and one they might commit.
	if req.Agent == AgentGemini {
		if path := m.telemetryPath(sessionID); path != "" {
			env = append(env,
				"GEMINI_TELEMETRY_ENABLED=true",
				"GEMINI_TELEMETRY_TARGET=local",
				"GEMINI_TELEMETRY_OUTFILE="+path,
				// Prompts on, so a Gemini session is in Memory like every other
				// agent's: Claude Code, Codex, OpenCode and DeepSeek all keep
				// what was asked, and this file sits in the same 0700 data
				// directory as their transcripts. Off was a caution from before
				// Memory existed (ADR-027, amended 2026-10-01).
				"GEMINI_TELEMETRY_LOG_PROMPTS=true",
			)
		}
	}
	// Continuing a conversation under its own id while an earlier process of
	// ours still runs it would put two writers on one transcript. That process
	// is one Caprock started and has lost the terminal of, so it is stopped
	// first (see stopLeftover).
	if req.Resume != "" && !req.Fork {
		m.stopLeftover(ctx, req.Resume)
	}
	spec := ptyman.Spec{ID: sessionID, Command: command, Args: args, Dir: cwd, Env: env, Cols: req.Cols, Rows: req.Rows,
		Meta: map[string]string{metaKind: agent}}
	// A fresh worktree with a setup command runs it in this terminal first,
	// through the wrapper, which then becomes the agent (worktreesetup.go).
	setupPending := setup.wrap(&spec, m.SetupExe)
	if setup.command != "" && !setupPending {
		m.log.Warn("the project has a setup command, but no Caprock binary to run it from; starting the agent without it",
			"component", "agents", "worktree", cwd)
	}
	if port > 0 {
		spec.Meta[metaPort] = strconv.Itoa(port)
	}
	if req.EndWhenDone {
		spec.Meta[metaEndWhenDone] = "1"
	}
	// The PTY process is controlled explicitly via Signal/Close; it must not die
	// when the caller's context (e.g. an HTTP request) ends.
	sess, err := m.pty.Spawn(context.WithoutCancel(ctx), spec)
	if err != nil {
		return nil, fmt.Errorf("spawn %s: %w", command, err)
	}
	a := &Agent{
		SessionID: sessionID, Cwd: cwd, Worktree: worktree, Command: command + " " + join(args), StartedAt: time.Now(), Kind: agent, Port: port, NativeID: nativeID, EndWhenDone: req.EndWhenDone,
		sess: sess, ring: ringFor(sess, 256<<10), inputs: termbuf.NewInputs(termbuf.InputTTL), log: m.log, subs: map[chan []byte]struct{}{}, done: make(chan struct{}), onExit: m.OnExit,
		pumped: make(chan struct{}), retry: retryOf(req, cwd), argv0: command, argv: args,
	}
	cols, rows := req.Cols, req.Rows
	if cols <= 0 {
		cols = 120 // ptyman's defaults
	}
	if rows <= 0 {
		rows = 40
	}
	a.setSize(cols, rows)
	if setupPending {
		a.setupDone = make(chan struct{})
	}
	m.mu.Lock()
	m.agents[sessionID] = a
	m.forgetExitLocked(sessionID)
	m.mu.Unlock()

	// Persist ownership so a restart knows what Caprock launched.
	_ = m.store.WithTx(ctx, func(q store.Querier) error {
		// The agent is recorded here, so the session carries it from its first
		// row: the filter, the per-agent totals and the badge all read this
		// column, and a Gemini session that arrived labelled "claude" would be
		// counted under the wrong agent forever.
		if err := store.UpsertSession(ctx, q, sessionID, store.SessionPatch{Cwd: cwd, Agent: agent, Subscription: sub}); err != nil {
			return err
		}
		if err := store.MarkOwned(ctx, q, sessionID, worktree, a.Command, sess.PID()); err != nil {
			return err
		}
		// A chat is a session started in a folder of the chats workspace:
		// a new chat, or one carried on there (ADR-071).
		if m.IsChatDir(cwd) {
			if err := store.MarkChat(ctx, q, sessionID); err != nil {
				return err
			}
		}
		if sm := subagentModelFor(agent, req.SubagentModel); sm != "" {
			if err := store.SetSubagentModel(ctx, q, sessionID, sm); err != nil {
				return err
			}
		}
		if req.Automation {
			if err := store.MarkBrainAutomation(ctx, q, sessionID, time.Now().UnixMilli()); err != nil {
				return err
			}
		}
		if req.Fork && agent == AgentClaude {
			// A fork is a new session id continuing req.Resume's conversation.
			return store.SetParent(ctx, q, sessionID, req.Resume)
		}
		return nil
	})

	go a.pump(m.OnOutput)
	go a.wait(m)
	if typed != "" {
		go m.typeWhenReady(a, typed)
	}
	m.log.Info("spawned owned session", "component", "agents", "session_id", sessionID, "cwd", cwd, "pid", sess.PID())
	return a, nil
}

// Get returns a running agent.
func (m *Manager) Get(sessionID string) (*Agent, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a := m.lookupLocked(sessionID)
	return a, a != nil
}

// List returns running agents.
func (m *Manager) List() []*Agent {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Agent, 0, len(m.agents))
	for _, a := range m.agents {
		out = append(out, a)
	}
	return out
}

// OwnedRunning lists the sessions Caprock started that are still running.
//
// The name says "owned" rather than "all" because that distinction is the whole
// safety story: `m.agents` holds only sessions this manager spawned, and a
// caller must not have to remember that. See PauseOwned.
//
// Shell tabs are not sessions and are left out: the spend cap pauses work
// that costs money, and a shell costs none.
func (m *Manager) OwnedRunning() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.agents))
	for id, a := range m.agents {
		if a.Kind == KindShell {
			continue
		}
		out = append(out, id)
	}
	return out
}

// PauseOwned pauses a session Caprock started, reporting whether it did.
//
// An id this manager does not own is refused here, quietly and without error:
// [Rule 7] is enforced at the thing that holds the process handles rather than
// by whoever happens to be calling. A session started in someone's own terminal
// is watched and never signalled, however much it is costing — and the daily
// spend cap, the one caller today, therefore cannot violate that rule even by
// mistake.
//
// [Rule 7]: ../../CLAUDE.md
func (m *Manager) PauseOwned(sessionID string) (bool, error) {
	a, ok := m.Get(sessionID)
	if !ok {
		return false, nil
	}
	if err := a.sess.Signal(ptyman.SignalPause); err != nil {
		return false, err
	}
	return true, nil
}

// ResumeOwned resumes a session Caprock started, reporting whether it did. Like
// PauseOwned it refuses, quietly, any id this manager does not own: the
// plan-window stop resumes what it paused hours earlier, and the session may
// have ended — or never been ours — by then.
func (m *Manager) ResumeOwned(sessionID string) (bool, error) {
	a, ok := m.Get(sessionID)
	if !ok {
		return false, nil
	}
	if err := a.sess.Signal(ptyman.SignalResume); err != nil {
		return false, err
	}
	return true, nil
}

// OwnedRunningKind lists the running sessions Caprock started with one coding
// agent ("claude", "codex", …). The plan-window stop pauses only Claude Code:
// Anthropic's window is not spent by a Codex or Gemini session.
func (m *Manager) OwnedRunningKind(kind string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for id, a := range m.agents {
		if a.Kind == kind {
			out = append(out, id)
		}
	}
	return out
}

// Input writes typed bytes to an owned session.
func (m *Manager) Input(sessionID string, data []byte) error {
	a, ok := m.Get(sessionID)
	if !ok {
		return errNotOwned(sessionID)
	}
	// Answered in the terminal: the buttons are out of date.
	m.typedInput(a, data)
	a.typedAny.Store(true)
	_, err := a.sess.Write(data)
	return err
}

// InputSeq types sequenced input (terminal protocol v2) exactly once per
// client, and returns the client's last applied sequence. Sequence 0 types
// nothing and only asks for it. A pty-host keeps the numbering itself, so it
// survives this daemon; a session without one is numbered here.
func (m *Manager) InputSeq(sessionID, client string, seq uint64, data []byte) (uint64, error) {
	a, ok := m.Get(sessionID)
	if !ok {
		return 0, errNotOwned(sessionID)
	}
	if seq > 0 {
		m.typedInput(a, data)
		a.typedAny.Store(true)
	}
	if sw, ok := a.sess.(ptyman.SeqWriter); ok {
		last, err := sw.WriteSeq(client, seq, data)
		if !errors.Is(err, ptyman.ErrNotSupported) {
			return last, err
		}
	}
	return a.inputs.Apply(client, seq, func() error {
		_, err := a.sess.Write(data)
		return err
	})
}

// Signal pauses/resumes/kills an owned session.
func (m *Manager) Signal(sessionID string, sig ptyman.Signal) error {
	a, ok := m.Get(sessionID)
	if !ok {
		return errNotOwned(sessionID)
	}
	if sig == ptyman.SignalTerm || sig == ptyman.SignalKill {
		a.stopped.Store(true)
	}
	return a.sess.Signal(sig)
}

// endGrace is how long End lets a session finish on its own before killing it.
var endGrace = ShutdownGrace

// End stops an owned session the way a user closing its tab means it: asked
// first (SIGTERM, resumed if paused so it can act on it), so Claude Code
// flushes its transcript and the conversation can be continued with
// --resume; killed only if it is still running after endGrace. It returns
// once the request is sent; the kill, if needed, follows in the background.
func (m *Manager) End(sessionID string) error {
	a, ok := m.Get(sessionID)
	if !ok {
		return errNotOwned(sessionID)
	}
	a.stopped.Store(true)
	if a.sess.Paused() {
		_ = a.sess.Signal(ptyman.SignalResume)
	}
	if err := a.sess.Signal(ptyman.SignalTerm); err != nil {
		return a.sess.Signal(ptyman.SignalKill)
	}
	grace := endGrace // read once, here: tests change it between calls
	go func() {
		done := make(chan struct{})
		go func() { _ = a.sess.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(grace):
			_ = a.sess.Signal(ptyman.SignalKill)
		}
	}()
	return nil
}

// Resize an owned session's terminal.
func (m *Manager) Resize(sessionID string, cols, rows int) error {
	a, ok := m.Get(sessionID)
	if !ok {
		return errNotOwned(sessionID)
	}
	return a.Resize(cols, rows)
}

// ShutdownGrace is how long a session gets to finish on its own before it is
// killed. Claude Code flushes its transcript and releases its session id on
// the way out; none of that survives a SIGKILL.
const ShutdownGrace = 5 * time.Second

// Shutdown lets go of every owned session that lives in a pty-host — it keeps
// running, and the next daemon reattaches it (ADR-033) — and ends the rest,
// giving each a chance to stop cleanly.
//
// It used to SIGKILL them outright, so upgrading Caprock — or any restart of
// the daemon — silently destroyed whatever the user had running under it,
// mid-turn, with no warning and nothing written out. A tool that watches your
// work must not be the thing that eats it. SIGTERM first was better and still
// ended the session; a pty-host is the fix. What is left for this path is a
// session that could not be given one (the in-process fallback).
//
// Every session is signalled first and waited on together, so the grace period
// is spent once rather than once per session. Anything still alive at the end
// is killed: shutdown has to terminate, and a process that ignores SIGTERM has
// had its chance.
func (m *Manager) Shutdown() {
	// A prompt answered a moment ago must not come back after the restart.
	m.persisting.Wait()
	var agents []*Agent
	for _, a := range m.List() {
		if d, ok := a.sess.(ptyman.Detacher); ok && d.Detach() == nil {
			continue
		}
		agents = append(agents, a)
	}
	if len(agents) == 0 {
		return
	}
	for _, a := range agents {
		a.stopped.Store(true)
		// A paused session cannot act on a signal, so let it run first —
		// otherwise SIGTERM sits undelivered and every one of them takes the
		// full grace period before being killed anyway.
		if a.sess.Paused() {
			_ = a.sess.Signal(ptyman.SignalResume)
		}
		_ = a.sess.Signal(ptyman.SignalTerm)
	}
	done := make(chan struct{})
	go func() {
		var wg sync.WaitGroup
		for _, a := range agents {
			wg.Add(1)
			go func(a *Agent) {
				defer wg.Done()
				_ = a.sess.Wait()
			}(a)
		}
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(ShutdownGrace):
	}
	// Close kills anything still running and releases the PTY either way.
	for _, a := range agents {
		_ = a.sess.Close()
	}
}

// ErrNotOwned is returned for control operations on a session Caprock did not spawn.
var ErrNotOwned = errors.New("caprock did not start this session, so only its own terminal can control it")

func errNotOwned(id string) error { return fmt.Errorf("%w: %s", ErrNotOwned, id) }

func (a *Agent) pump(onOutput func(string)) {
	if a.pumped != nil {
		defer close(a.pumped)
	}
	r := bufio.NewReader(a.sess.Output())
	buf := make([]byte, 32<<10)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			a.ring.write(chunk)
			if a.setupDone != nil && a.sawSetupMarker(chunk) {
				// What is drawn next is the agent's: "ready" is measured
				// from here, not from the setup's last line.
				a.outAt.Store(0)
			} else {
				a.outAt.Store(time.Now().UnixNano())
			}
			if now := time.Now().UnixNano(); now > a.quietUntil {
				a.ioAt.Store(now)
			}
			a.mu.Lock()
			for ch := range a.subs {
				select {
				case ch <- chunk:
				default:
				}
			}
			a.mu.Unlock()
			if onOutput != nil {
				onOutput(a.SessionID)
			}
		}
		if err != nil {
			return
		}
	}
}

// exitDrain bounds the wait for an exited session's last output.
const exitDrain = 750 * time.Millisecond

// exitCoder lets a ptyman.Session report an exit code without an *exec.ExitError
// (used by the in-memory test backend).
type exitCoder interface{ ExitCode() int }

func (a *Agent) wait(m *Manager) {
	err := a.sess.Wait()
	code := 0
	if err != nil {
		var ee *exec.ExitError
		var ec exitCoder
		switch {
		case errors.As(err, &ee):
			code = ee.ExitCode()
		case errors.As(err, &ec):
			code = ec.ExitCode()
		default:
			code = -1
		}
	}
	if errors.Is(err, ptyman.ErrDetached) {
		// The daemon let go; the session runs on in its pty-host and the next
		// daemon reattaches it. Not an exit, so nothing is recorded as one —
		// and the open terminals are not told the session ended: closing their
		// channels would send them a normal "session ended" close, and the
		// browser would believe it. They drop when the daemon exits, which a
		// terminal reads as "reconnect".
		m.mu.Lock()
		delete(m.agents, a.SessionID)
		m.forgetFollowsLocked(a.SessionID)
		m.mu.Unlock()
		m.log.Info("owned session left running in its pty-host", "component", "agents", "session_id", a.SessionID, "pid", a.sess.PID())
		return
	}
	// The last output may still be on its way when the process is reaped:
	// it is read to the end first, so the screen the exit keeps is whole.
	if a.pumped != nil {
		select {
		case <-a.pumped:
		case <-time.After(exitDrain):
		}
	}
	if a.Kind != KindShell {
		m.recordExit(a, code, time.Now())
	}
	a.mu.Lock()
	a.exit, a.exited = code, true
	close(a.done)
	for ch := range a.subs {
		close(ch)
	}
	a.subs = map[chan []byte]struct{}{}
	a.mu.Unlock()
	m.mu.Lock()
	delete(m.agents, a.SessionID)
	followed := m.forgetFollowsLocked(a.SessionID)
	m.mu.Unlock()
	// A session a /clear started in the process ends with it.
	for _, id := range append([]string{a.SessionID}, followed...) {
		m.clearPermission(id)
		m.forgetCalls(id)
		m.forgetMode(id)
		m.forgetNudge(id)
		if a.Kind != KindShell {
			_ = m.store.WithTx(context.Background(), func(q store.Querier) error { return store.SetExit(context.Background(), q, id, code) })
		}
	}
	m.log.Info("owned session exited", "component", "agents", "session_id", a.SessionID, "code", code, "err", errStr(err))
	if a.onExit != nil {
		a.onExit(a.SessionID, code)
		for _, id := range followed {
			a.onExit(id, code)
		}
	}
}

// Snapshot returns the current terminal scrollback (for a fresh terminal connect).
func (a *Agent) Snapshot() []byte { return a.ring.snapshot() }

// Subscribe returns a channel of new output chunks and a cancel func. The channel
// is closed when the process exits.
func (a *Agent) Subscribe() (<-chan []byte, func()) {
	ch := make(chan []byte, 256)
	a.mu.Lock()
	if a.exited {
		a.mu.Unlock()
		close(ch)
		return ch, func() {}
	}
	a.subs[ch] = struct{}{}
	a.mu.Unlock()
	return ch, func() {
		a.mu.Lock()
		if _, ok := a.subs[ch]; ok {
			delete(a.subs, ch)
			close(ch)
		}
		a.mu.Unlock()
	}
}

// Ring is the session's output with offsets (terminal protocol v2).
func (a *Agent) Ring() *termbuf.Ring { return a.ring.r }

// Write types into the session.
func (a *Agent) Write(b []byte) error { _, err := a.sess.Write(b); return err }

// Resize the terminal.
func (a *Agent) Resize(cols, rows int) error {
	err := a.sess.Resize(cols, rows)
	if err == nil {
		a.setSize(cols, rows)
	}
	return err
}

// setSize records the terminal's size, for reading its screen.
func (a *Agent) setSize(cols, rows int) {
	a.sizeMu.Lock()
	a.cols, a.rows = cols, rows
	a.sizeMu.Unlock()
}

// size is the terminal's last known size; 0 when this daemon has not seen it
// (a session reattached from the last one), which termbuf.Screen reads as
// "wide".
func (a *Agent) size() (cols, rows int) {
	a.sizeMu.Lock()
	defer a.sizeMu.Unlock()
	return a.cols, a.rows
}

// Signal the process.
func (a *Agent) Signal(sig ptyman.Signal) error { return a.sess.Signal(sig) }

// Exited reports the exit state.
func (a *Agent) Exited() (int, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.exit, a.exited
}

// Paused reports the pause state; false for an Agent with no process
// behind it (a caller's fake).
func (a *Agent) Paused() bool { return a.sess != nil && a.sess.Paused() }

// LastIO is when the session last drew output or was typed into, as this
// daemon saw it; zero before either. A reattached session's replayed screen
// does not count (quietUntil), so after a restart this is zero until the
// session draws something new.
func (a *Agent) LastIO() time.Time {
	if ns := a.ioAt.Load(); ns != 0 {
		return time.Unix(0, ns)
	}
	return time.Time{}
}

// TouchIO records activity at t: input typed into the session.
func (a *Agent) TouchIO(t time.Time) { a.ioAt.Store(t.UnixNano()) }

// PID is the agent's (or shell's) own process id — the child of its pty-host,
// not the host. The resource meter starts its process tree here.
func (a *Agent) PID() int {
	if a.sess == nil {
		return 0
	}
	return a.sess.PID()
}

// childEnv is the environment for a spawned session: the user's login-shell
// environment (see internal/userenv — the daemon's own is launchd's bare one,
// and a session started with it cannot find gcloud, Homebrew or anything the
// profile exports) with Caprock/Claude nesting markers stripped, so a session
// Caprock launches is a normal top-level Claude Code session (transcripts
// persist, no "child session" mode) even when the daemon itself was started
// from inside one.
func childEnv(base []string) []string {
	drop := map[string]bool{
		"CLAUDE_CODE_CHILD_SESSION":    true,
		"CLAUDECODE":                   true,
		"CLAUDE_CODE_ENTRYPOINT":       true,
		"CLAUDE_CODE_SSE_PORT":         true,
		"CLAUDE_CODE_SESSION_ID":       true,
		"CLAUDE_CODE_SESSION_ATTENDED": true,
		"CLAUDE_CODE_MESSAGING_SOCKET": true,
		"CLAUDE_CODE_MESSAGING_TOKEN":  true,
		"CLAUDE_CODE_EXECPATH":         true,
		"CLAUDE_PID":                   true,
		"CLAUDE_EFFORT":                true,
		"AI_AGENT":                     true,
		// Claude Code sets it for the teammates it starts. It moves the
		// Keychain entry and .credentials.json off CLAUDE_CONFIG_DIR's
		// (ADR-048, amended 2026-10-18), so a session or a sign-in tab here
		// would read or write another directory's sign-in.
		"CLAUDE_SECURESTORAGE_CONFIG_DIR": true,
		"CAPROCK_DATA_DIR":                false, // keep: the child's own hook shim needs it
	}
	var out []string
	for _, kv := range base {
		k := kv
		if i := indexByte(kv, '='); i >= 0 {
			k = kv[:i]
		}
		if drop[k] {
			continue
		}
		out = append(out, kv)
	}
	out = append(out, "TERM=xterm-256color", "COLORTERM=truecolor")
	return withUTF8Locale(out, runtime.GOOS)
}

// onSubscription is env for a session on the subscription whose directory is
// dir. Claude Code keys its credentials, Keychain entry included, and Codex
// its auth.json and keyring entry, to this directory (ADR-048); it replaces
// any value the login shell exports, which is the user's own default. A
// credential the shell exports would outrank the directory's sign-in, and
// CLAUDE_SECURESTORAGE_CONFIG_DIR would key the Keychain to another
// directory: the session runs without them (subs.CredentialEnv).
func onSubscription(env []string, agent, dir string) []string {
	return withEnv(withoutEnv(env, subs.CredentialEnv(agent)), []string{subs.EnvVar(agent) + "=" + dir})
}

// withUTF8Locale is userenv.WithUTF8Locale, kept by name for the tests.
func withUTF8Locale(env []string, goos string) []string { return userenv.WithUTF8Locale(env, goos) }

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func errStr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func join(args []string) string {
	out := ""
	for i, s := range args {
		if i > 0 {
			out += " "
		}
		out += s
	}
	return out
}

// Done is closed when the process exits.
func (a *Agent) Done() <-chan struct{} { return a.done }
