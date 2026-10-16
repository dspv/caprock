package agents

// hermesLaunch starts Hermes Agent's interactive chat (`hermes chat`), built
// from its own `hermes --help` and `hermes chat --help`, Hermes Agent v0.21.6,
// read on 2026-10-15 (.ai/24-hermes.md):
//
//   - `chat` is the interactive session; the bare `hermes` is the same chat,
//     but its top-level `-m` "applies to -z/--oneshot and --tui" only, so
//     the subcommand is the one whose `-m, --model` reaches the session.
//   - `-r, --resume SESSION_ID` continues a session by Hermes's own id. There
//     is no flag that names a new session's id, and no fork: Hermes mints its
//     id (YYYYMMDD_HHMMSS_hex) when the CLI starts and writes the row on the
//     first message, so a new session is linked to its row afterwards, by
//     folder and that stamp (internal/sessionlink, ADR-069).
//   - `--yolo` "Bypass all dangerous command approval prompts": Caprock's
//     bypass mode. Hermes has no other permission modes to map to.
//   - `-q, --query QUERY`: "On a real TTY the prompt seeds an interactive
//     session (submitted literally as the first turn)". A Caprock tab is a
//     real TTY, so the first message starts the chat rather than ending it.
//
// Hermes has no flag that appends to its system prompt (it reads AGENTS.md
// in the folder itself), so a project's instructions are not passed.
func hermesLaunch(in launchInput) (launch, error) {
	l := launch{sessionID: in.SessionID, args: []string{"chat"}}
	if in.Resume != "" {
		native := in.NativeResume
		if native == "" {
			native = in.Resume
		}
		args, err := resumeArgs(AgentHermes, native, in.Fork)
		if err != nil {
			return launch{}, err
		}
		l.args = args
		l.sessionID = in.Resume
	}
	if in.Model != "" {
		l.args = append(l.args, "-m", in.Model)
	}
	if in.Mode == "bypassPermissions" {
		l.args = append(l.args, "--yolo")
	}
	l.args = append(l.args, in.Extra...)
	if p := promptArg(in); p != "" {
		l.args = append(l.args, "-q", p)
	}
	return l, nil
}
