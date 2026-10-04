package agents

import (
	"errors"
	"regexp"
)

// nativeID is what an agent's session id looks like: a UUID for Claude Code
// and Codex, ses_… for OpenCode. Anything else — a leading dash that would
// read as a flag, a quote, a space — is not an id and is not passed on.
var nativeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// ErrNoNativeResume is returned for an agent whose CLI cannot reopen a
// session by its id.
var ErrNoNativeResume = errors.New("this agent cannot reopen a session by id")

// resumeArgs is how each CLI is told to carry on a conversation it already
// has. The launch builders (argv.go) start from it, and so does NativeResume,
// so the dashboard's own resume and the one typed into the user's terminal
// cannot drift apart. id is the agent's own id: sessions.native_id for a
// Codex or OpenCode session Caprock started, the session id otherwise.
//
//   - claude: `--resume <id>`, and `--fork-session` to branch it under a new
//     id while the original keeps running.
//   - codex (codex-cli 0.160.0): `resume <id>`.
//   - opencode (1.15.10): `--session <id>`.
//   - gemini: `--resume` takes "latest" or an index into the current folder's
//     list, not an id, so nothing is sure to reopen this session.
//
// Forking is Claude Code's only: `codex fork` and `opencode --fork` exist, but
// both copy the history with its cost into a new session Caprock would count
// a second time.
func resumeArgs(agent, id string, fork bool) ([]string, error) {
	switch agent {
	case "", AgentClaude:
		if fork {
			return []string{"--resume", id, "--fork-session"}, nil
		}
		return []string{"--resume", id}, nil
	case AgentCodex:
		if fork {
			return nil, errors.New("this Codex session is still running; continue it here once it has ended")
		}
		return []string{"resume", id}, nil
	case AgentOpenCode:
		if fork {
			return nil, errors.New("this OpenCode session is still running; continue it here once it has ended")
		}
		return []string{"--session", id}, nil
	}
	return nil, ErrNoNativeResume
}

// NativeResume is the command that carries a session on in the user's own
// terminal — what they would type themselves: the CLI's own name and
// resumeArgs, with none of the flags Caprock adds for a session it runs
// (folder trust, a port, --no-daemon), which belong to Caprock's PTY and not
// to the user's terminal.
func NativeResume(agent, id string, fork bool) ([]string, error) {
	if !nativeID.MatchString(id) {
		return nil, errors.New("not a session id: " + id)
	}
	args, err := resumeArgs(agent, id, fork)
	if err != nil {
		return nil, err
	}
	bin := agent
	if bin == "" {
		bin = AgentClaude
	}
	return append([]string{bin}, args...), nil
}
