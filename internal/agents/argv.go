package agents

import (
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"strconv"
	"strings"
)

// launchInput is what every agent's argv is built from. The fields are the
// dialog's choices in Caprock's own vocabulary — Claude Code's permission-mode
// names — and each builder translates them into its CLI's, or leaves them off
// where the CLI has no counterpart.
type launchInput struct {
	// SessionID is the fresh id Caprock records a new session under.
	SessionID string
	Cwd       string
	Model     string
	Mode      string
	// Resume is the stored session being continued; NativeResume is the
	// agent's own id for it, which differs only for a Codex or OpenCode
	// session Caprock started (sessions.native_id).
	Resume       string
	NativeResume string
	Fork         bool
	// Port is the loopback port OpenCode's own server is told to listen on,
	// so Caprock can learn the session id it creates. 0 for everyone else.
	Port int
	// Prompt is the first message, sent as the session starts — a relay's
	// brief, which the user has read and approved. Only for a new session.
	Prompt string
	// AddDirs are directories outside the working directory that the session
	// is allowed to read without being asked: the places Caprock itself
	// writes files the user then refers to (a pasted screenshot, a quick
	// chat's own folder). Without them a user who has
	// `permissions.blockReadsOutsideWorkingDirectories` on is asked about
	// Caprock's own files.
	AddDirs []string
	Extra   []string
}

// launch is one agent's start: its arguments, the environment it adds, and
// the id Caprock records the session under.
type launch struct {
	args      []string
	env       []string
	sessionID string
}

// builders is the table ADR-026 asked for once a third CLI arrived: one
// function per agent, each written from that CLI's own --help (the flags and
// the versions they were read from are in .ai/16-opencode.md and
// .ai/19-codex.md), and none sharing a guess about another's spelling.
var builders = map[string]func(launchInput) (launch, error){
	AgentClaude:   claudeLaunch,
	AgentGemini:   geminiLaunch,
	AgentCodex:    codexLaunch,
	AgentOpenCode: opencodeLaunch,
}

//nolint:unparam // one signature for every builder; Claude Code's has nothing to refuse
func claudeLaunch(in launchInput) (launch, error) {
	l := launch{sessionID: in.SessionID}
	switch {
	case in.Resume != "" && in.Fork:
		// A branch: the original keeps running under its own id, and this
		// process gets a fresh one. Both flags are required together —
		// Claude Code refuses --session-id with --resume otherwise.
		l.args, _ = resumeArgs(AgentClaude, in.Resume, true)
		l.args = append(l.args, "--session-id", in.SessionID)
	case in.Resume != "":
		// Continuing the same conversation, which already has an id.
		l.args, _ = resumeArgs(AgentClaude, in.Resume, false)
		l.sessionID = in.Resume
	default:
		l.args = []string{"--session-id", in.SessionID}
	}
	if in.Model != "" {
		l.args = append(l.args, "--model", in.Model)
	}
	// "Bypass · never asks" is spawned as `--dangerously-skip-permissions`,
	// the flag the orchestrator has always used for its own unattended
	// workers. Claude Code maps it to the same mode as `--permission-mode
	// bypassPermissions` (read in 2.1.292: `dangerouslySkipPermissions ?
	// "bypassPermissions" : permissionMode`); one spelling for both paths
	// keeps the first-run warning and its consent (ADR-041) on one flag. The
	// two are not combined.
	//
	// Neither lifts `permissions.blockReadsOutsideWorkingDirectories`, an
	// opt-in perimeter that asks in every mode — the owner's prompt flood of
	// 2026-10-07 was that setting, not the mode. AddDirs below answers it for
	// the directories Caprock itself writes.
	switch in.Mode {
	case "":
	case "bypassPermissions":
		l.args = append(l.args, "--dangerously-skip-permissions")
	default:
		l.args = append(l.args, "--permission-mode", in.Mode)
	}
	for _, d := range in.AddDirs {
		l.args = append(l.args, "--add-dir", d)
	}
	l.args = append(l.args, in.Extra...)
	// `claude [options] [prompt]`: a positional prompt starts the interactive
	// session with it already sent.
	if p := promptArg(in); p != "" {
		l.args = append(l.args, p)
	}
	return l, nil
}

func geminiLaunch(in launchInput) (launch, error) {
	if in.Resume != "" {
		return launch{}, errors.New("caprock does not continue Gemini sessions; start a new one")
	}
	// Gemini CLI refuses to start in a directory it has not been told to
	// trust, and in a PTY nobody is watching that is an invisible hang rather
	// than an error. Caprock only ever launches a directory the user picked in
	// the dialog, which is the same consent the prompt asks for.
	l := launch{sessionID: in.SessionID, args: []string{"--skip-trust", "--session-id", in.SessionID}}
	if in.Model != "" {
		l.args = append(l.args, "-m", in.Model)
	}
	// Gemini spells the permission modes differently and accepts only its own
	// four; an unmapped mode is left off rather than guessed at.
	if mode := geminiApprovalMode(in.Mode); mode != "" {
		l.args = append(l.args, "--approval-mode", mode)
	}
	l.args = append(l.args, in.Extra...)
	// -i/--prompt-interactive: "Execute the provided prompt and continue in
	// interactive mode" (-p would run headless and exit).
	if p := promptArg(in); p != "" {
		l.args = append(l.args, "--prompt-interactive", p)
	}
	return l, nil
}

// codexLaunch starts the Codex TUI (codex-cli 0.160.0).
//
//   - `codex resume <id>` continues a thread; there is no flag that sets a new
//     thread's id, so a new session is linked to its rollout afterwards
//     (sessionlink).
//   - `--no-daemon` keeps the session in the process Caprock started rather
//     than in a shared background server it did not, so pause and kill act on
//     the work itself.
//   - `-c projects={"<cwd>"={trust_level="trusted"}}` answers the folder-trust
//     prompt for this run only. It is a per-invocation override: nothing is
//     written to ~/.codex/config.toml.
func codexLaunch(in launchInput) (launch, error) {
	l := launch{sessionID: in.SessionID}
	if in.Resume != "" {
		native := in.NativeResume
		if native == "" {
			native = in.Resume
		}
		args, err := resumeArgs(AgentCodex, native, in.Fork)
		if err != nil {
			return launch{}, err
		}
		l.args = args
		l.sessionID = in.Resume
	}
	l.args = append(l.args, "--no-daemon", "-c", codexTrust(in.Cwd))
	if in.Model != "" {
		l.args = append(l.args, "-m", in.Model)
	}
	l.args = append(l.args, codexPermissions(in.Mode)...)
	l.args = append(l.args, in.Extra...)
	// `codex [OPTIONS] [PROMPT]`: the TUI opens with the prompt sent.
	if p := promptArg(in); p != "" {
		l.args = append(l.args, p)
	}
	return l, nil
}

// codexPermissions maps a Claude permission mode onto Codex's two axes, the
// sandbox (-s) and when to ask (-a). Modes with no honest counterpart are left
// off and the user's own config.toml decides.
func codexPermissions(mode string) []string {
	switch mode {
	case "acceptEdits":
		// Edits inside the workspace without asking; anything else asks.
		return []string{"--sandbox", "workspace-write", "--ask-for-approval", "on-request"}
	case "plan":
		// Reads, changes nothing.
		return []string{"--sandbox", "read-only", "--ask-for-approval", "on-request"}
	case "bypassPermissions":
		return []string{"--dangerously-bypass-approvals-and-sandbox"}
	default:
		return nil
	}
}

// codexTrust is the -c value that marks the directory trusted for one run. The
// path is written as a TOML basic string, so a quote or a Windows backslash in
// it cannot end the key early. Both spellings are trusted when the directory
// is reached through a symlink (/tmp is /private/tmp on macOS), because Codex
// looks the folder up by the path it resolved.
func codexTrust(cwd string) string {
	paths := []string{cwd}
	if real, err := filepath.EvalSymlinks(cwd); err == nil && real != cwd {
		paths = append(paths, real)
	}
	parts := make([]string, 0, len(paths))
	for _, p := range paths {
		parts = append(parts, tomlString(p)+`={trust_level="trusted"}`)
	}
	return "projects={" + strings.Join(parts, ",") + "}"
}

// tomlString quotes s as a TOML basic string.
func tomlString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, `\u%04X`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// opencodeLaunch starts the OpenCode TUI (opencode 1.15.10).
//
//   - `--session <id>` continues a session; a new one gets its id from
//     OpenCode when the first message is sent, which Caprock learns from the
//     TUI's own server (`--port`, see sessionlink).
//   - `-m provider/model` is OpenCode's model syntax.
//   - Permissions: `plan` is OpenCode's built-in `plan` agent (`--agent plan`,
//     edits denied); `acceptEdits` sets OPENCODE_PERMISSION={"bash":"ask"} so
//     commands ask while edits go through. OpenCode's default already lets
//     its build agent use every tool, and an override cannot remove the asks
//     its config keeps for directories outside the project, so bypass is left
//     to the user's own config rather than claimed.
func opencodeLaunch(in launchInput) (launch, error) {
	l := launch{sessionID: in.SessionID}
	if in.Resume != "" {
		native := in.NativeResume
		if native == "" {
			native = in.Resume
		}
		args, err := resumeArgs(AgentOpenCode, native, in.Fork)
		if err != nil {
			return launch{}, err
		}
		l.args = args
		l.sessionID = in.Resume
	}
	if in.Port > 0 {
		l.args = append(l.args, "--port", strconv.Itoa(in.Port))
	}
	if in.Model != "" {
		l.args = append(l.args, "-m", in.Model)
	}
	switch in.Mode {
	case "plan":
		l.args = append(l.args, "--agent", "plan")
	case "acceptEdits":
		l.env = append(l.env, `OPENCODE_PERMISSION={"bash":"ask"}`)
	}
	l.args = append(l.args, in.Extra...)
	// --prompt: "prompt to use", sent when the TUI opens.
	if p := promptArg(in); p != "" {
		l.args = append(l.args, "--prompt", p)
	}
	return l, nil
}

// promptArg is the first message as one argument, or "" when there is none or
// the session is being resumed (a resume has its conversation already). A
// leading dash would be read as a flag by every one of these parsers, so such
// a prompt is given a leading space, which no agent minds.
func promptArg(in launchInput) string {
	p := strings.TrimRight(in.Prompt, " \t\r\n")
	if strings.TrimSpace(p) == "" || in.Resume != "" {
		return ""
	}
	if strings.HasPrefix(p, "-") {
		p = " " + p
	}
	return p
}

// flattenForBatch makes a prompt safe to pass through a Windows .cmd or .bat
// shim (how npm installs Claude Code, Codex and Gemini CLI there): cmd.exe ends
// the command line at a newline and expands %VAR%, so lines are joined and
// percent signs doubled. The brief survives as one paragraph.
func flattenForBatch(p string) string {
	p = strings.ReplaceAll(p, "\r\n", "\n")
	lines := strings.Split(p, "\n")
	kept := lines[:0]
	for _, l := range lines {
		if t := strings.TrimSpace(l); t != "" {
			kept = append(kept, t)
		}
	}
	return strings.ReplaceAll(strings.Join(kept, " / "), "%", "%%")
}

// freePort asks the kernel for a loopback port nobody holds. It is released
// before OpenCode binds it, so another process could take it in between; the
// cost of that is a session that is not linked, never a wrong link, because
// whatever answers on the port would have to speak OpenCode's event stream.
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}
